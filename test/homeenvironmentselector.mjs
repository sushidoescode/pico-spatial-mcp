import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  defaultHomeEnvironmentSelectorDependencies,
  executeSelectHomeEnvironment,
  parseCurrentDefaultSpace,
  parseWorldSpaceMarkerLine,
  registerHomeEnvironmentSelectorTools,
  selectHomeEnvironmentOutputSchema,
} from "../dist/homeenvironmentselector.js";
import {
  deriveFitRequest,
  homeEnvironmentDatasetSchema,
  loadPackagedHomeEnvironmentDataset,
  rankHomeEnvironments,
} from "../dist/homeenvironmentcatalog.js";
import { canonicalIdentity } from "../dist/runreceiptidentity.js";
import { querySceneAnchorsOutputSchema } from "../dist/sceneanchors.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(
  repoRoot,
  "docs",
  "evidence",
  "home-environments",
  "2026-08-29-pico-emulator-6.0",
);
const refreshEvidenceRoot = path.join(
  repoRoot,
  "docs",
  "evidence",
  "home-environments",
  "2026-08-30-selector-refresh",
);
const selectorLiveResultPath = path.join(
  repoRoot,
  "docs",
  "evidence",
  "home-environments",
  "2026-08-30-selector-live",
  "switch-result.json",
);
const selectorLiveHoldout2Path = path.join(
  repoRoot,
  "docs",
  "evidence",
  "home-environments",
  "2026-08-30-selector-live",
  "holdout-2-verify-call.json",
);
const RECEIPT_ID = "fcd5d2877dfa8b10ec453a403d0e6c0fb1deff14097f33b7a1be90cd3a8070ce";
const SERIAL = "emulator-5554";
const PACKAGE_NAME = "com.fleet.swanmissiontable";
const BOOT_ID = "c0bd8c41-7928-476a-ae8a-a71d89465686";
const TARGET_DIALOG_SHA256 = "97a77c1f9acb7dd7b073bdec1ea8c403ab2fc9bbf337913abd700ad068f274aa";
const SNAPSHOT_RE = /^[a-f0-9]{64}$/;
const SOURCE = {
  requirements: [{ label: "TABLE", minimumExtentM: [0.7, 0.4] }],
};
const RUNTIME = {
  serial: SERIAL,
  packageName: PACKAGE_NAME,
  expectedBuildReceiptId: RECEIPT_ID,
  expectedStageStyle: "Mixed",
};
const committedLiveSwitchResult = JSON.parse(fs.readFileSync(selectorLiveResultPath, "utf8"));
const committedLiveHoldout2 = JSON.parse(fs.readFileSync(selectorLiveHoldout2Path, "utf8"));
const LIVE_RUNTIME = committedLiveSwitchResult.request.runtime;
const WORLDSPACE_LINE = "1788064752.864  1268  1476 I WorldSpace: WorldSpaceDB, getSpace: space=DBSpace(id=1, name=Default Space, isInternal=true, canDelete=false, isCurrent=true, envId=XiataAncientPath, envName=, defaultEnvId=XiataAncientPath, immersive=0.0, thumbnail=scene/XiataAncientPath/xiata.png, recentApps=com.fleet.swanmissiontable, firstChoose=false, isRenamed=false, description=, isBeachFrontCinema=false, spaceProperty=normal, spaceSession=1_1786961148148_7000)";
const LIVE_INDENTED_WORLDSPACE_LINE = "         1788089659.329  1268  1476 I WorldSpace: WorldSpaceDB, getSpace: space=DBSpace(id=1, name=Default Space, isInternal=true, canDelete=false, isCurrent=true, envId=XiataAncientPath, envName=, defaultEnvId=XiataAncientPath, immersive=0.0, thumbnail=scene/XiataAncientPath/xiata.png, recentApps=com.fleet.swanmissiontable, firstChoose=false, isRenamed=false, description=, isBeachFrontCinema=false, spaceProperty=normal, spaceSession=1_1786961148148_7000)";
const MARKER_EPOCH = 1788064722.111;
const MARKER_TAG = "PICOHomeEnvironmentSelector";

function readEvidence(name) {
  return JSON.parse(fs.readFileSync(path.join(evidenceRoot, name), "utf8"));
}

function readRefreshEvidence(name) {
  return JSON.parse(fs.readFileSync(path.join(refreshEvidenceRoot, name), "utf8"));
}

function withProductionLabels(input) {
  const query = structuredClone(input);
  // The selector requests two stable reads. Older measured fixtures captured three, so retain
  // their complete final transition rather than presenting a two-transition aggregate as one.
  const transitionStarts = query.drift.deltas
    .map((delta, index) => delta.metric === "anchor_count" ? index : -1)
    .filter((index) => index >= 0);
  if (transitionStarts.length > 1) query.drift.deltas = query.drift.deltas.slice(transitionStarts.at(-1));
  const wallArtCount = query.histogram.WALL_ART ?? 0;
  const sourceAnchor = query.anchors[0];
  for (let index = 0; index < wallArtCount; index++) {
    query.anchors.push({
      ...structuredClone(sourceAnchor),
      traceId: `anchor-${String(9000 + index).padStart(4, "0")}`,
      runtimeUuid: `selector-wall-art-${index}`,
      labels: ["WALL_ART"],
      boundsM: [0.5, 0.05, 0.5],
      semanticAssignments: {
        domain: "unknown",
        rawCount: 1,
        alignment: "unverified",
        relationEligible: false,
      },
    });
  }
  query.matchedAnchorCount = query.anchors.length;
  query.requestedLabels = ["FLOOR", "TABLE", "WALL_ART"];
  return querySceneAnchorsOutputSchema.parse(query);
}

const bedroomDayQuery = withProductionLabels(readEvidence("bedroom-day-read-1.json"));
const livingroomDayQuery = withProductionLabels(readEvidence("livingroom-day-read-1.json"));
const livingroomNightQuery = withProductionLabels(readEvidence("livingroom-night-read-1.json"));
const livingroomDayRefresh4Query = withProductionLabels(readRefreshEvidence("livingroom-day-refresh-read-4.json"));
const completeLabelAbsentPreQuery = querySceneAnchorsOutputSchema.parse(
  committedLiveSwitchResult.response.structuredContent.verification.preQuery,
);

function withRuntime(query, runtime) {
  return mutateReady(query, (changed) => {
    const binding = changed.applicationRuntimeBinding;
    binding.buildReceiptId = runtime.expectedBuildReceiptId;
    binding.buildReceiptPath = binding.buildReceiptPath.replace(RECEIPT_ID, runtime.expectedBuildReceiptId);
    const bindReceipt = changed.actionReceipts.find((entry) => entry.action === "bind_application_runtime");
    bindReceipt.ack.buildReceiptId = runtime.expectedBuildReceiptId;
  });
}

const POST_SNAPSHOT_COMPLETENESS_MUTATIONS = [
  ["missing monotonic query time", (query) => { query.queriedAtMonotonicNs = null; }],
  ["missing running tracking state", (query) => { query.trackingState = null; }],
  ["missing stable-read retry evidence", (query) => { query.retries = 0; }],
  ["missing requested-label coverage", (query) => { query.requestedLabels = ["FLOOR", "TABLE"]; }],
  ["non-emulator boot identity", (query) => { query.applicationRuntimeBinding.liveIdentity.bootQemu = "0"; }],
  ["missing lossless external geometry", (query) => { query.geometryRef = null; }],
  ["missing runtime-bind receipt", (query) => {
    query.actionReceipts = query.actionReceipts.filter((receipt) => receipt.action !== "bind_application_runtime");
  }],
  ["missing bridge-broadcast receipt", (query) => {
    query.actionReceipts = query.actionReceipts.filter((receipt) => receipt.action !== "bridge_broadcast");
  }],
  ["missing bridge-pull receipt", (query) => {
    query.actionReceipts = query.actionReceipts.filter((receipt) => receipt.action !== "bridge_payload_pull");
  }],
  ["missing bridge-cleanup receipt", (query) => {
    query.actionReceipts = query.actionReceipts.filter((receipt) => receipt.action !== "bridge_payload_cleanup");
  }],
  ["missing geometry-publication receipt", (query) => {
    query.actionReceipts = query.actionReceipts.filter((receipt) => receipt.action !== "publish_geometry");
  }],
  ["mismatched geometry-publication receipt", (query) => {
    query.actionReceipts.find((receipt) => receipt.action === "publish_geometry").ack.sha256 = "a".repeat(64);
  }],
  ["missing stable-read drift evidence", (query) => { query.drift.deltas = []; }],
];

function observation(overrides = {}) {
  const result = {
    observedAtEpochSeconds: 1788064752.864,
    spaceId: 1,
    spaceName: "Default Space",
    isCurrent: true,
    sceneId: "XiataAncientPath",
    spaceSession: "1_1786961148148_7000",
    source: "WorldSpaceDB getSpace",
    sceneIdentityRole: "coarse_consistency_only_non_discriminating",
    ...overrides,
  };
  result.rawLine = Object.hasOwn(overrides, "rawLine")
    ? overrides.rawLine
    : WORLDSPACE_LINE
      .replace("1788064752.864", String(result.observedAtEpochSeconds))
      .replace("id=1,", `id=${result.spaceId},`)
      .replace("name=Default Space", `name=${result.spaceName}`)
      .replace("isCurrent=true", `isCurrent=${String(result.isCurrent)}`)
      .replace("envId=XiataAncientPath", `envId=${result.sceneId}`)
      .replace("spaceSession=1_1786961148148_7000", `spaceSession=${result.spaceSession}`);
  return result;
}

function markerRawLine(nonce, {
  epoch = MARKER_EPOCH,
  tag = MARKER_TAG,
  message = `MARK ${nonce}`,
} = {}) {
  return `${epoch}  4321  4322 I ${tag}: ${message}`;
}

function markerReceipt(baseline, overrides = {}) {
  const nonce = overrides.nonce ?? baseline.snapshotId;
  const tag = overrides.tag ?? MARKER_TAG;
  const message = overrides.message ?? `MARK ${nonce}`;
  const observedAtEpochSeconds = overrides.observedAtEpochSeconds ?? MARKER_EPOCH;
  return {
    serial: overrides.serial ?? baseline.serial,
    nonce,
    tag,
    message,
    status: "marked",
    observedAtEpochSeconds,
    rawLine: overrides.rawLine ?? markerRawLine(nonce, {
      epoch: observedAtEpochSeconds,
      tag,
      message,
    }),
  };
}

function baselineReceipt() {
  return {
    datasetId: "pico-emulator-6.0-home-environments-v1",
    datasetContentSha256: canonicalIdentity(
      homeEnvironmentDatasetSchema.parse(loadPackagedHomeEnvironmentDataset()),
    ).sha256,
    serial: SERIAL,
    packageName: PACKAGE_NAME,
    expectedBuildReceiptId: RECEIPT_ID,
    bootId: BOOT_ID,
    snapshotId: bedroomDayQuery.snapshotId,
  };
}

async function withFakeAdb(logcatDumps, operation) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pico-selector-adb-"));
  const fakeAdb = path.join(temporaryDirectory, "fake-adb.mjs");
  const statePath = path.join(temporaryDirectory, "logcat-count.txt");
  const argvPath = path.join(temporaryDirectory, "argv.jsonl");
  fs.writeFileSync(fakeAdb, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PICO_SELECTOR_FAKE_ARGV, JSON.stringify(args) + "\\n");
if (args.includes("logcat")) {
  const statePath = process.env.PICO_SELECTOR_FAKE_STATE;
  const count = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, "utf8")) : 0;
  fs.writeFileSync(statePath, String(count + 1));
  const dumps = JSON.parse(process.env.PICO_SELECTOR_FAKE_DUMPS ?? "[]");
  const dump = dumps[count] ?? dumps.at(-1) ?? "";
  if (dump === "__ERROR__") {
    process.stderr.write("synthetic logcat failure");
    process.exit(1);
  }
  process.stdout.write(dump);
  process.exit(0);
}
if (args.includes("shell") && args.includes("log")) process.exit(0);
process.stderr.write("unexpected fake adb args: " + args.join(" "));
process.exit(2);
`);
  fs.chmodSync(fakeAdb, 0o755);
  const previousAdb = process.env.PICO_ADB;
  const previousState = process.env.PICO_SELECTOR_FAKE_STATE;
  const previousDumps = process.env.PICO_SELECTOR_FAKE_DUMPS;
  const previousArgv = process.env.PICO_SELECTOR_FAKE_ARGV;
  process.env.PICO_ADB = fakeAdb;
  process.env.PICO_SELECTOR_FAKE_STATE = statePath;
  process.env.PICO_SELECTOR_FAKE_DUMPS = JSON.stringify(logcatDumps);
  process.env.PICO_SELECTOR_FAKE_ARGV = argvPath;
  try {
    return await operation({
      readArgv: () => fs.existsSync(argvPath)
        ? fs.readFileSync(argvPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [],
    });
  } finally {
    if (previousAdb === undefined) delete process.env.PICO_ADB;
    else process.env.PICO_ADB = previousAdb;
    if (previousState === undefined) delete process.env.PICO_SELECTOR_FAKE_STATE;
    else process.env.PICO_SELECTOR_FAKE_STATE = previousState;
    if (previousDumps === undefined) delete process.env.PICO_SELECTOR_FAKE_DUMPS;
    else process.env.PICO_SELECTOR_FAKE_DUMPS = previousDumps;
    if (previousArgv === undefined) delete process.env.PICO_SELECTOR_FAKE_ARGV;
    else process.env.PICO_SELECTOR_FAKE_ARGV = previousArgv;
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function hostObserved(targetHash) {
  return {
    status: "host_selection_observed",
    targetTile: "Livingroom Day",
    afterDialogSha256: targetHash,
    receipts: [
      { action: "bind", status: "ok", detail: `serial ${SERIAL} -> PID 93013 -> main window 77` },
      { action: "focus", status: "ok", detail: "focused PID 93013" },
      { action: "open_picker", status: "ok", detail: "pressed Accessibility select_scene_button" },
      { action: "dialog_guard", status: "ok", detail: "exact guarded dialog" },
      { action: "capture_preflight", status: "ok", detail: "bound window is capturable" },
      { action: "focus", status: "ok", detail: "refocused PID 93013" },
      { action: "click", status: "ok", detail: "one left-button CGEvent emitted" },
      { action: "capture", status: "ok", detail: `sha256 ${targetHash}` },
      { action: "close", status: "ok", detail: "pressed stored AX close" },
      { action: "close_verify", status: "ok", detail: "stored dialog disappeared" },
    ],
    close: { closed: true },
  };
}

function hostManual(detail = "guarded host selection requires macOS") {
  return {
    status: "manual_switch_required",
    targetTile: "Livingroom Day",
    detail,
    baselineSafe: true,
  };
}

function hostFailed(detail = "selected-dialog screenshot hash did not match the measured target hash") {
  return {
    status: "host_selection_not_observed",
    targetTile: "Livingroom Day",
    selectedTile: null,
    detail,
    receipts: [
      { action: "bind", status: "ok", detail: "exact serial/PID/window binding" },
      { action: "click", status: "ok", detail: "one guarded click attempted" },
      { action: "capture", status: "failed", detail },
    ],
  };
}

function terminalQuery(status) {
  if (status === "label_absent") {
    const query = structuredClone(livingroomDayQuery);
    query.status = status;
    query.anchors = [];
    query.matchedAnchorCount = 0;
    delete query.histogram.TABLE;
    delete query.histogram.FLOOR;
    delete query.histogram.WALL_ART;
    query.error = { code: status, detail: "ready mesh contains none of the requested labels" };
    return querySceneAnchorsOutputSchema.parse(query);
  }
  return querySceneAnchorsOutputSchema.parse({
    status,
    snapshotId: null,
    applicationRuntimeBinding: null,
    queriedAtMonotonicNs: null,
    trackingState: null,
    retries: 0,
    totalAnchorCount: 0,
    matchedAnchorCount: 0,
    geometryRef: null,
    anchors: [],
    histogram: {},
    drift: {
      effectivePolicy: {
        count: "advisory",
        maxTransformDeltaM: 0.01,
        maxTransformDeltaDeg: 1,
        maxExtentDeltaM: 0.01,
        topology: "strict",
      },
      exactSnapshotChanged: false,
      withinPolicy: false,
      countDelta: 0,
      maxTransformDeltaM: 0,
      maxTransformDeltaDeg: 0,
      maxExtentDeltaM: 0,
      labelSetChanges: 0,
      topologyChanges: 0,
      unmatchedPrevious: 0,
      unmatchedCurrent: 0,
      ambiguities: [],
      deltas: [],
    },
    requestedLabels: ["FLOOR", "TABLE", "WALL_ART"],
    semanticRelationPolicy: {
      labelLevelSelection: true,
      triangleRelations: "refused",
      reason: "semantic_assignment_alignment_unverified",
    },
    actionReceipts: [],
    error: { code: status, detail: `representative ${status} terminal result` },
    evidenceCeiling: "structural",
  });
}

function selectorDeps({
  dataset = loadPackagedHomeEnvironmentDataset(),
  preQuery = bedroomDayQuery,
  postQuery = livingroomDayQuery,
  preObservation = observation({ observedAtEpochSeconds: 1788064692.863 }),
  postObservation = observation(),
  hostResult,
  verifyOnly = false,
  observeError = null,
  observeErrorMessage = null,
  markError = null,
  markerOverrides = {},
} = {}) {
  const target = dataset.environments.find((entry) => entry.tile === "Livingroom Day");
  const calls = [];
  const queryInputs = [];
  const hostInputs = [];
  return {
    dataset,
    calls,
    queryInputs,
    hostInputs,
    async observeCurrentDefaultSpace(serial, afterMarker) {
      const phase = afterMarker ? "post" : "pre";
      calls.push(`observe-${phase}`);
      assert.equal(serial, SERIAL);
      if (afterMarker) {
        assert.match(afterMarker.nonce, SNAPSHOT_RE);
        assert.deepEqual(
          afterMarker,
          markerReceipt({ serial: SERIAL, snapshotId: afterMarker.nonce }, markerOverrides),
        );
      }
      if (observeError === phase) {
        throw new Error(observeErrorMessage ?? `${phase} WorldSpace observation failed`);
      }
      return structuredClone(phase === "pre" ? preObservation : postObservation);
    },
    async querySceneAnchors(input) {
      const phase = verifyOnly || queryInputs.length > 0 ? "post" : "pre";
      calls.push(`query-${phase}`);
      queryInputs.push(structuredClone(input));
      const value = phase === "pre" ? preQuery : postQuery;
      return structuredClone(querySceneAnchorsOutputSchema.parse(value));
    },
    async markWorldSpace(serial, nonce) {
      calls.push("mark");
      assert.equal(serial, SERIAL);
      assert.match(nonce, SNAPSHOT_RE);
      if (markError) throw new Error(markError);
      return markerReceipt({ serial, snapshotId: nonce }, markerOverrides);
    },
    async selectHost(selectionTarget, picker) {
      calls.push("host-select");
      hostInputs.push({ selectionTarget: structuredClone(selectionTarget), picker: structuredClone(picker) });
      return structuredClone(hostResult ?? hostObserved(target.selectedDialogSha256));
    },
  };
}

async function execute(input, deps) {
  const result = await executeSelectHomeEnvironment(input, deps);
  const checked = selectHomeEnvironmentOutputSchema.safeParse(result);
  assert.equal(checked.success, true, checked.success ? "" : JSON.stringify(checked.error.issues));
  return result;
}

function switchInput(overrides = {}) {
  return { action: "switch", ...SOURCE, runtime: RUNTIME, ...overrides };
}

function missionSwitchInput(overrides = {}) {
  return { action: "switch", briefId: "swanmissiontable", runtime: RUNTIME, ...overrides };
}

function verifyInput(proof, overrides = {}) {
  return {
    action: "verify",
    ...SOURCE,
    runtime: RUNTIME,
    baseline: proof.baseline,
    marker: proof.marker,
    ...overrides,
  };
}

function mutateReady(query, mutate) {
  const changed = structuredClone(query);
  mutate(changed);
  return querySceneAnchorsOutputSchema.parse(changed);
}

async function manualProof() {
  const deps = selectorDeps({ hostResult: hostManual() });
  const result = await execute(switchInput(), deps);
  assert.equal(result.status, "manual_switch_required");
  return {
    baseline: structuredClone(result.baseline),
    marker: structuredClone(result.verification.marker),
  };
}

function useFailureIdentity(result, failureResult) {
  const changed = structuredClone(result);
  changed.status = "verification_failed";
  changed.error = structuredClone(failureResult.error);
  if (Object.hasOwn(failureResult, "failurePhase")) {
    changed.failurePhase = failureResult.failurePhase;
  }
  return changed;
}

async function realFailurePhaseResults() {
  const proof = await manualProof();
  return {
    pre_world_space: await execute(switchInput(), selectorDeps({ preObservation: null })),
    pre_query: await execute(switchInput(), selectorDeps({ preQuery: terminalQuery("not_ready") })),
    marker: await execute(switchInput(), selectorDeps({ markError: "marker failed" })),
    host_selection: await execute(switchInput(), selectorDeps({ hostResult: hostFailed() })),
    post_world_space: await execute(switchInput(), selectorDeps({ postObservation: null })),
    post_query: await execute(switchInput(), selectorDeps({ postQuery: bedroomDayQuery })),
    classification: await execute(switchInput(), selectorDeps({ postQuery: livingroomNightQuery })),
    verify_post_world_space: await execute(
      verifyInput(proof),
      selectorDeps({ verifyOnly: true, postObservation: null }),
    ),
    verify_post_query: await execute(
      verifyInput(proof),
      selectorDeps({ verifyOnly: true, postQuery: bedroomDayQuery }),
    ),
    verify_classification: await execute(
      verifyInput(proof),
      selectorDeps({ verifyOnly: true, postQuery: livingroomNightQuery }),
    ),
  };
}

function replaceFailureQuery(result, phase, query) {
  const changed = structuredClone(result);
  changed.verification[`${phase}Query`] = structuredClone(query);
  changed.verification[`${phase}SnapshotId`] = query.snapshotId;
  return changed;
}

let realFailureReceiptCasesPromise;

async function realFailureReceiptCases() {
  if (realFailureReceiptCasesPromise) return realFailureReceiptCasesPromise;
  realFailureReceiptCasesPromise = (async () => {
    const cases = [];
    const add = async (name, phase, code, input, deps, nonExhibiting) => {
      const result = await execute(input, deps);
      cases.push({ name, phase, code, result, nonExhibiting });
    };
    const exactPreObservation = observation({ observedAtEpochSeconds: 1788064692.863 });
    const exactPostObservation = observation();
    const successful = await execute(switchInput(), selectorDeps());

    for (const [name, options, code] of [
      ["pre observation failed", { observeError: "pre" }, "world_space_observation_failed"],
      ["pre observation invalid", { preObservation: { ...exactPreObservation, unexpected: true } }, "world_space_observation_invalid"],
      ["pre observation missing", { preObservation: null }, "world_space_observation_missing"],
    ]) {
      await add(name, "pre_world_space", code, switchInput(), selectorDeps(options), (result) => {
        result.verification.preWorldSpaceAttempt = expectedObservationAttempt(
          "pre_world_space",
          "observed",
          exactPreObservation,
        );
      });
    }

    await add(
      "pre bridge result invalid",
      "pre_query",
      "bridge_result_invalid",
      switchInput(),
      selectorDeps({ preQuery: { invalid: true } }),
      (result) => Object.assign(result, replaceFailureQuery(result, "pre", bedroomDayQuery)),
    );

    const terminalStatuses = [
      ["label_absent", "bridge_label_absent"],
      ["not_ready", "bridge_not_ready"],
      ["stage_not_open", "bridge_stage_not_open"],
      ["bridge_unavailable", "bridge_bridge_unavailable"],
      ["stage_mismatch", "bridge_stage_mismatch"],
      ["invalid_payload", "bridge_invalid_payload"],
      ["binding_failed", "bridge_binding_failed"],
    ];
    for (const [status, code] of terminalStatuses) {
      await add(
        `pre terminal ${status}`,
        "pre_query",
        code,
        switchInput(),
        selectorDeps({ preQuery: terminalQuery(status) }),
        (result) => Object.assign(result, replaceFailureQuery(result, "pre", bedroomDayQuery)),
      );
    }

    const identityMutations = [
      ["binding", "identity_drift_binding", (query) => { query.applicationRuntimeBinding = null; }],
      ["serial", "identity_drift_serial", (query) => {
        query.applicationRuntimeBinding.serial = "emulator-5556";
        query.applicationRuntimeBinding.liveIdentity.serial = "emulator-5556";
      }],
      ["package", "identity_drift_package", (query) => {
        query.applicationRuntimeBinding.packageName = "com.example.other";
        query.applicationRuntimeBinding.foregroundProcess.packageName = "com.example.other";
        query.applicationRuntimeBinding.foregroundProcess.component = "com.example.other/.MainActivity";
      }],
      ["receipt", "identity_drift_receipt", (query) => { query.applicationRuntimeBinding.buildReceiptId = "a".repeat(64); }],
      ["boot", "identity_drift_boot", (query) => { query.applicationRuntimeBinding.liveIdentity.bootId = "another-boot-id"; }],
      ["stage", "identity_drift_stage", (query) => {
        query.applicationRuntimeBinding.requestedStageStyle = "Full";
        query.applicationRuntimeBinding.observedStageStyle = "Full";
      }],
      ["root", "identity_drift_root", (query) => { query.applicationRuntimeBinding.rootContainer = "unbound-root"; }],
    ];
    for (const [identity, code, mutate] of identityMutations) {
      if (identity !== "boot") {
        await add(
          `pre identity ${identity}`,
          "pre_query",
          code,
          switchInput(),
          selectorDeps({ preQuery: mutateReady(bedroomDayQuery, mutate) }),
          (result) => Object.assign(result, replaceFailureQuery(result, "pre", bedroomDayQuery)),
        );
      }
    }

    const driftMutations = [
      ["policy mismatch", "scene_drift_policy_mismatch", (query) => {
        query.applicationRuntimeBinding.effectiveSceneDriftPolicy.maxExtentDeltaM = 0.02;
      }],
      ["out of policy", "scene_drift_out_of_policy", (query) => {
        query.drift.withinPolicy = false;
        query.drift.maxTransformDeltaM = 0.02;
      }],
    ];
    for (const [name, code, mutate] of driftMutations) {
      await add(
        `pre drift ${name}`,
        "pre_query",
        code,
        switchInput(),
        selectorDeps({ preQuery: mutateReady(bedroomDayQuery, mutate) }),
        (result) => Object.assign(result, replaceFailureQuery(result, "pre", bedroomDayQuery)),
      );
    }

    const preWithoutSnapshot = mutateReady(bedroomDayQuery, (query) => { query.snapshotId = null; });
    await add(
      "pre snapshot missing",
      "pre_query",
      "snapshot_missing",
      switchInput(),
      selectorDeps({ preQuery: preWithoutSnapshot }),
      (result) => Object.assign(result, replaceFailureQuery(result, "pre", bedroomDayQuery)),
    );
    await add(
      "pre coarse scene mismatch",
      "pre_query",
      "coarse_scene_mismatch",
      switchInput(),
      selectorDeps({ preObservation: observation({ sceneId: "AnotherCoarseScene" }) }),
      (result) => {
        result.verification.preWorldSpaceAttempt.observation = structuredClone(exactPreObservation);
      },
    );

    await add(
      "marker command failed",
      "marker",
      "world_space_marker_failed",
      switchInput(),
      selectorDeps({ markError: "marker failed" }),
      (result) => {
        result.verification.marker = markerReceipt(result.baseline);
      },
    );
    await add(
      "marker receipt mismatch",
      "marker",
      "world_space_marker_mismatch",
      switchInput(),
      selectorDeps({ markerOverrides: { serial: "emulator-5556" } }),
      (result) => { result.verification.marker.serial = result.baseline.serial; },
    );

    await add(
      "host result invalid",
      "host_selection",
      "host_selection_invalid",
      switchInput(),
      selectorDeps({ hostResult: { status: "invalid-host-result" } }),
      (result) => { result.hostSelection = hostFailed(); },
    );
    await add(
      "host target mismatch",
      "host_selection",
      "host_selection_wrong_target",
      switchInput(),
      selectorDeps({ hostResult: { ...hostManual(), targetTile: "Bedroom Day" } }),
      (result) => { result.hostSelection = hostManual(); },
    );
    await add(
      "host selection not observed",
      "host_selection",
      "host_selection_not_observed",
      switchInput(),
      selectorDeps({ hostResult: hostFailed() }),
      (result) => { result.hostSelection = hostManual(); },
    );

    for (const [name, options, code] of [
      ["post observation failed", { observeError: "post" }, "world_space_observation_failed"],
      ["post observation invalid", { postObservation: { ...exactPostObservation, unexpected: true } }, "world_space_observation_invalid"],
      ["post observation missing", { postObservation: null }, "world_space_observation_missing"],
    ]) {
      await add(name, "post_world_space", code, switchInput(), selectorDeps(options), (result) => {
        result.verification.postWorldSpaceAttempt = expectedObservationAttempt(
          "post_world_space",
          "observed",
          exactPostObservation,
        );
      });
    }
    await add(
      "post coarse scene mismatch",
      "post_world_space",
      "coarse_scene_mismatch",
      switchInput(),
      selectorDeps({ postObservation: observation({ sceneId: "AnotherCoarseScene" }) }),
      (result) => {
        result.verification.postWorldSpaceAttempt.observation = structuredClone(exactPostObservation);
      },
    );

    await add(
      "post bridge result invalid",
      "post_query",
      "bridge_result_invalid",
      switchInput(),
      selectorDeps({ postQuery: { invalid: true } }),
      (result) => Object.assign(result, replaceFailureQuery(result, "post", livingroomDayQuery)),
    );
    for (const [status, code] of terminalStatuses) {
      await add(
        `post terminal ${status}`,
        "post_query",
        code,
        switchInput(),
        selectorDeps({ postQuery: terminalQuery(status) }),
        (result) => Object.assign(result, replaceFailureQuery(result, "post", livingroomDayQuery)),
      );
    }
    for (const [identity, code, mutate] of identityMutations) {
      await add(
        `post identity ${identity}`,
        "post_query",
        code,
        switchInput(),
        selectorDeps({ postQuery: mutateReady(livingroomDayQuery, mutate) }),
        (result) => Object.assign(result, replaceFailureQuery(result, "post", livingroomDayQuery)),
      );
    }
    for (const [name, code, mutate] of driftMutations) {
      await add(
        `post drift ${name}`,
        "post_query",
        code,
        switchInput(),
        selectorDeps({ postQuery: mutateReady(livingroomDayQuery, mutate) }),
        (result) => Object.assign(result, replaceFailureQuery(result, "post", livingroomDayQuery)),
      );
    }
    const postWithoutSnapshot = mutateReady(livingroomDayQuery, (query) => { query.snapshotId = null; });
    await add(
      "post snapshot missing",
      "post_query",
      "snapshot_missing",
      switchInput(),
      selectorDeps({ postQuery: postWithoutSnapshot }),
      (result) => Object.assign(result, replaceFailureQuery(result, "post", livingroomDayQuery)),
    );
    await add(
      "post snapshot unchanged",
      "post_query",
      "snapshot_unchanged",
      switchInput(),
      selectorDeps({ postQuery: bedroomDayQuery }),
      (result) => Object.assign(result, replaceFailureQuery(result, "post", livingroomDayQuery)),
    );

    const noMatchQuery = mutateReady(livingroomDayQuery, (query) => { query.histogram.SYNTHETIC = 1; });
    await add(
      "classification no match",
      "classification",
      "classification_no_match",
      switchInput(),
      selectorDeps({ postQuery: noMatchQuery }),
      (result) => { result.verification.classification.histogramMatches = ["Livingroom Day"]; },
    );
    const ambiguousDataset = structuredClone(loadPackagedHomeEnvironmentDataset());
    const livingroom = ambiguousDataset.environments.find((entry) => entry.tile === "Livingroom Day");
    const bedroom = ambiguousDataset.environments.find((entry) => entry.tile === "Bedroom Day");
    bedroom.totalAnchorCountRange = [...livingroom.totalAnchorCountRange];
    bedroom.histogramRanges = structuredClone(livingroom.histogramRanges);
    await add(
      "classification ambiguous",
      "classification",
      "classification_ambiguous",
      switchInput(),
      selectorDeps({ dataset: ambiguousDataset }),
      (result) => { result.verification.classification.histogramMatches = ["Livingroom Day"]; },
    );
    const incompleteQuery = mutateReady(livingroomDayQuery, (query) => {
      query.requestedLabels = ["FLOOR", "WALL_ART"];
    });
    await add(
      "post ready receipt incomplete requested labels",
      "post_query",
      "bridge_result_invalid",
      switchInput(),
      selectorDeps({ postQuery: incompleteQuery }),
      (result) => Object.assign(result, replaceFailureQuery(result, "post", livingroomDayQuery)),
    );
    const extentMismatchQuery = mutateReady(livingroomDayQuery, (query) => {
      for (const anchor of query.anchors) {
        if (anchor.labels.includes("TABLE")) anchor.boundsM = [99, anchor.boundsM[1], 99];
      }
    });
    await add(
      "classification extent mismatch",
      "classification",
      "classification_extent_mismatch",
      switchInput(),
      selectorDeps({ postQuery: extentMismatchQuery }),
      (result) => {
        result.verification.classification.predicates.surfaceExtentMultisetsMatch = true;
        result.verification.classification.predicates.requirementsFit = true;
      },
    );
    await add(
      "wrong unique environment",
      "classification",
      "wrong_unique_environment",
      switchInput(),
      selectorDeps({ postQuery: livingroomNightQuery }),
      (result) => { result.verification.classification = structuredClone(successful.verification.classification); },
    );

    const proof = await manualProof();
    await add(
      "verify post observation missing",
      "post_world_space",
      "world_space_observation_missing",
      verifyInput(proof),
      selectorDeps({ verifyOnly: true, postObservation: null }),
      (result) => {
        result.verification.postWorldSpaceAttempt = expectedObservationAttempt(
          "post_world_space",
          "observed",
          exactPostObservation,
        );
      },
    );
    await add(
      "verify post snapshot unchanged",
      "post_query",
      "snapshot_unchanged",
      verifyInput(proof),
      selectorDeps({ verifyOnly: true, postQuery: bedroomDayQuery }),
      (result) => Object.assign(result, replaceFailureQuery(result, "post", livingroomDayQuery)),
    );
    await add(
      "verify wrong unique environment",
      "classification",
      "wrong_unique_environment",
      verifyInput(proof),
      selectorDeps({ verifyOnly: true, postQuery: livingroomNightQuery }),
      (result) => { result.verification.classification = structuredClone(successful.verification.classification); },
    );

    return cases;
  })();
  return realFailureReceiptCasesPromise;
}

const OBSERVATION_CODE_BY_OUTCOME = {
  failed: "world_space_observation_failed",
  invalid: "world_space_observation_invalid",
  missing: "world_space_observation_missing",
};
const OBSERVATION_DIAGNOSTIC_BY_OUTCOME = {
  failed: "WorldSpace observation dependency failed",
  invalid: "WorldSpace observation did not match the strict current Default Space schema",
};

function expectedObservationAttempt(phase, outcome, observed = observation()) {
  const attempt = {
    phase,
    outcome,
  };
  if (outcome === "observed") attempt.observation = structuredClone(observed);
  if (outcome === "failed" || outcome === "invalid") {
    attempt.diagnostic = OBSERVATION_DIAGNOSTIC_BY_OUTCOME[outcome];
  }
  return attempt;
}

function observationFailureCases(cases) {
  return cases.filter(({ code }) => Object.values(OBSERVATION_CODE_BY_OUTCOME).includes(code));
}

test("parses only a current Default Space WorldSpaceDB getSpace row", () => {
  assert.deepEqual(parseCurrentDefaultSpace(WORLDSPACE_LINE), observation());
  assert.deepEqual(
    parseCurrentDefaultSpace(LIVE_INDENTED_WORLDSPACE_LINE),
    observation({
      observedAtEpochSeconds: 1788089659.329,
      rawLine: LIVE_INDENTED_WORLDSPACE_LINE,
    }),
  );

  for (const invalid of [
    WORLDSPACE_LINE.replace("isCurrent=true", "isCurrent=false"),
    WORLDSPACE_LINE.replace("name=Default Space", "name=Viewing Space"),
    WORLDSPACE_LINE.replace("WorldSpaceDB, getSpace", "DataTracking, getSpace"),
    WORLDSPACE_LINE.replace("WorldSpaceDB, getSpace", "WorldSpaceDB, getSpaces"),
    WORLDSPACE_LINE.replace("envId=XiataAncientPath", "envId="),
    WORLDSPACE_LINE.replace("1788064752.864", "not-an-epoch"),
    WORLDSPACE_LINE.replace("isCurrent=true", "isCurrent=true, isCurrent=true"),
    WORLDSPACE_LINE.slice(0, -1),
  ]) {
    assert.equal(parseCurrentDefaultSpace(invalid), null, invalid);
  }
});

test("raw marker and WorldSpace parsers reject control separators and malformed process columns", async (t) => {
  const nonce = bedroomDayQuery.snapshotId;
  const validMarker = markerRawLine(nonce);
  const markerRows = [
    ["embedded CR", validMarker.replace(`${MARKER_EPOCH}  4321`, `${MARKER_EPOCH}\r4321`)],
    ["embedded form feed", validMarker.replace(`${MARKER_EPOCH}  4321`, `${MARKER_EPOCH}\f4321`)],
    ["embedded vertical tab", validMarker.replace(`${MARKER_EPOCH}  4321`, `${MARKER_EPOCH}\v4321`)],
    ["wrong priority", validMarker.replace(" I PICOHomeEnvironmentSelector", " W PICOHomeEnvironmentSelector")],
    ["malformed PID", validMarker.replace("4321  4322 I", "pid  4322 I")],
    ["missing PID", validMarker.replace("4321  4322 I", "4322 I")],
    ["malformed TID", validMarker.replace("4321  4322 I", "4321  tid I")],
    ["missing TID", validMarker.replace("4321  4322 I", "4321 I")],
  ];
  const worldSpaceRows = [
    ["embedded CR", WORLDSPACE_LINE.replace("1788064752.864  1268", "1788064752.864\r1268")],
    ["embedded form feed", WORLDSPACE_LINE.replace("1788064752.864  1268", "1788064752.864\f1268")],
    ["embedded vertical tab", WORLDSPACE_LINE.replace("1788064752.864  1268", "1788064752.864\v1268")],
    ["wrong priority", WORLDSPACE_LINE.replace(" I WorldSpace", " W WorldSpace")],
    ["malformed PID", WORLDSPACE_LINE.replace("1268  1476 I", "pid  1476 I")],
    ["missing PID", WORLDSPACE_LINE.replace("1268  1476 I", "1476 I")],
    ["malformed TID", WORLDSPACE_LINE.replace("1268  1476 I", "1268  tid I")],
    ["missing TID", WORLDSPACE_LINE.replace("1268  1476 I", "1268 I")],
  ];

  for (const [name, row] of markerRows) {
    await t.test(`marker ${name}`, () => {
      assert.equal(parseWorldSpaceMarkerLine(row), null);
    });
  }
  for (const [name, row] of worldSpaceRows) {
    await t.test(`WorldSpace ${name}`, () => {
      assert.equal(parseCurrentDefaultSpace(row), null);
    });
  }
});

test("one-row guards reject all non-column C0/C1 controls while allowing horizontal-tab columns", async (t) => {
  const nonce = bedroomDayQuery.snapshotId;
  const validMarker = markerRawLine(nonce);
  const tabbedMarker = `${MARKER_EPOCH}\t4321\t4322\tI ${MARKER_TAG}: MARK ${nonce}`;
  const tabbedWorldSpace = WORLDSPACE_LINE.replace(
    "1788064752.864  1268  1476 I",
    "1788064752.864\t1268\t1476\tI",
  );
  const disallowedCodePoints = [
    ...Array.from({ length: 0x09 }, (_, codePoint) => codePoint),
    ...Array.from({ length: 0x20 - 0x0a }, (_, offset) => 0x0a + offset),
    ...Array.from({ length: 0xa0 - 0x7f }, (_, offset) => 0x7f + offset),
    0x2028,
    0x2029,
  ];
  const display = (codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

  await t.test("horizontal tabs are accepted in the logcat columns", () => {
    assert.notEqual(parseWorldSpaceMarkerLine(tabbedMarker), null);
    assert.notEqual(parseCurrentDefaultSpace(tabbedWorldSpace), null);
  });

  await t.test("WorldSpace payload rejects every disallowed control and payload tab", () => {
    const accepted = disallowedCodePoints.filter((codePoint) => (
      parseCurrentDefaultSpace(
        WORLDSPACE_LINE.replace("description=", `description=${String.fromCodePoint(codePoint)}`),
      ) !== null
    ));
    assert.deepEqual(accepted.map(display), []);
    assert.equal(
      parseCurrentDefaultSpace(WORLDSPACE_LINE.replace("description=", "description=\t")),
      null,
    );
  });

  await t.test("marker and WorldSpace columns reject every non-tab control", () => {
    const acceptedMarkerColumns = disallowedCodePoints.filter((codePoint) => (
      parseWorldSpaceMarkerLine(
        validMarker.replace(`${MARKER_EPOCH}  4321`, `${MARKER_EPOCH}${String.fromCodePoint(codePoint)}4321`),
      ) !== null
    ));
    const acceptedWorldSpaceColumns = disallowedCodePoints.filter((codePoint) => (
      parseCurrentDefaultSpace(
        WORLDSPACE_LINE.replace(
          "1788064752.864  1268",
          `1788064752.864${String.fromCodePoint(codePoint)}1268`,
        ),
      ) !== null
    ));
    assert.deepEqual(acceptedMarkerColumns.map(display), []);
    assert.deepEqual(acceptedWorldSpaceColumns.map(display), []);
  });

  await t.test("marker payload rejects every non-tab control", () => {
    const accepted = disallowedCodePoints.filter((codePoint) => (
      parseWorldSpaceMarkerLine(
        validMarker.replace(MARKER_TAG, `PICO${String.fromCodePoint(codePoint)}HomeEnvironmentSelector`),
      ) !== null
    ));
    assert.deepEqual(accepted.map(display), []);
  });
});

test("live marker creation returns only the exact newly observed emitted row", async (t) => {
  const nonce = bedroomDayQuery.snapshotId;
  const staleRawLine = markerRawLine(nonce);
  const freshEpoch = MARKER_EPOCH + 1;
  const freshRawLine = markerRawLine(nonce, { epoch: freshEpoch });

  await t.test("ignores a stale same-nonce row and returns the exact fresh row", async () => {
    const receipt = await withFakeAdb([
      `${staleRawLine}\n`,
      `${staleRawLine}\n`,
      `${staleRawLine}\n${freshRawLine}\n`,
    ], async ({ readArgv }) => {
      const produced = await defaultHomeEnvironmentSelectorDependencies().markWorldSpace(SERIAL, nonce);
      assert.deepEqual(readArgv(), [
        ["-s", SERIAL, "logcat", "-d", "-v", "epoch"],
        ["-s", SERIAL, "shell", "log", "-p", "i", "-t", MARKER_TAG, `MARK ${nonce}`],
        ["-s", SERIAL, "logcat", "-d", "-v", "epoch"],
        ["-s", SERIAL, "logcat", "-d", "-v", "epoch"],
      ]);
      return produced;
    });

    assert.deepEqual(receipt, {
      serial: SERIAL,
      nonce,
      tag: MARKER_TAG,
      message: `MARK ${nonce}`,
      status: "marked",
      observedAtEpochSeconds: freshEpoch,
      rawLine: freshRawLine,
    });
  });

  await t.test("rejects when only a different row can be observed", async () => {
    const wrongRow = markerRawLine(nonce, { message: `MARK ${"a".repeat(64)}` });
    await assert.rejects(
      withFakeAdb(["", `${wrongRow}\n`, "__ERROR__"], async () => (
        defaultHomeEnvironmentSelectorDependencies().markWorldSpace(SERIAL, nonce)
      )),
    );
  });
});

test("live post observation ignores markerless rows at or before the durable boundary", async () => {
  const baseline = baselineReceipt();
  const marker = markerReceipt(baseline);
  const before = observation({ observedAtEpochSeconds: marker.observedAtEpochSeconds - 1 });
  const equal = observation({ observedAtEpochSeconds: marker.observedAtEpochSeconds });
  const firstLater = observation({
    observedAtEpochSeconds: marker.observedAtEpochSeconds + 1,
    spaceSession: "first_later_session",
  });
  const secondLater = observation({
    observedAtEpochSeconds: marker.observedAtEpochSeconds + 2,
    spaceSession: "second_later_session",
  });
  const dump = [
    before.rawLine,
    equal.rawLine,
    `malformed ${firstLater.rawLine}`,
    firstLater.rawLine,
    secondLater.rawLine,
  ].join("\n");

  const observed = await withFakeAdb([`${dump}\n`], async ({ readArgv }) => {
    const result = await defaultHomeEnvironmentSelectorDependencies()
      .observeCurrentDefaultSpace(SERIAL, marker);
    assert.deepEqual(readArgv(), [["-s", SERIAL, "logcat", "-d", "-v", "epoch"]]);
    return result;
  });

  assert.deepEqual(observed, firstLater);
});

test("rank is static and invokes no WorldSpace, bridge, marker, or host dependency", async () => {
  const deps = selectorDeps();
  const result = await execute({ action: "rank", ...SOURCE }, deps);

  assert.equal(result.status, "ranked");
  assert.equal(result.selectedTarget, "Livingroom Day");
  assert.equal(result.ranking.candidates[0].tile, "Livingroom Day");
  assert.deepEqual(deps.calls, []);
});

test("returns no_fit without runtime work when no eligible measured surface fits", async () => {
  const deps = selectorDeps();
  const result = await execute({
    action: "switch",
    requirements: [{ label: "TABLE", minimumExtentM: [99, 99] }],
    runtime: RUNTIME,
  }, deps);

  assert.equal(result.status, "no_fit");
  assert.equal(result.selectedTarget, null);
  assert.deepEqual(deps.calls, []);
});

test("manual baselines bind the exact canonical dataset contents", async () => {
  const deps = selectorDeps({ hostResult: hostManual() });
  const expectedDatasetContentSha256 = canonicalIdentity(
    homeEnvironmentDatasetSchema.parse(deps.dataset),
  ).sha256;

  const result = await execute(switchInput(), deps);

  assert.equal(result.dataset.datasetContentSha256, expectedDatasetContentSha256);
  assert.equal(result.baseline.datasetContentSha256, expectedDatasetContentSha256);
});

test("verify rejects old or same-legacy-identity baselines from different dataset contents before dependencies", async (t) => {
  const datasetA = homeEnvironmentDatasetSchema.parse(loadPackagedHomeEnvironmentDataset());
  const datasetB = structuredClone(datasetA);
  const dayB = datasetB.environments.find((entry) => entry.tile === "Livingroom Day");
  dayB.surfaces.TABLE[1][0] += 0.001;
  dayB.extentClusters.TABLE[1].extentM[0] += 0.001;
  assert.equal(homeEnvironmentDatasetSchema.safeParse(datasetB).success, true);
  assert.equal(datasetB.datasetId, datasetA.datasetId);
  assert.deepEqual(datasetB.measurement, datasetA.measurement);

  const rankingRequest = deriveFitRequest({
    requirements: [{ label: "TABLE", minimumExtentM: [0.7, 0.4] }],
  });
  assert.notDeepEqual(
    rankHomeEnvironments(datasetB, rankingRequest).candidates[0].fits,
    rankHomeEnvironments(datasetA, rankingRequest).candidates[0].fits,
  );

  const digestA = canonicalIdentity(datasetA).sha256;
  const digestB = canonicalIdentity(datasetB).sha256;
  assert.notEqual(digestA, digestB);
  const baselineA = { ...baselineReceipt(), datasetContentSha256: digestA };

  await t.test("missing digest is an invalid request", async () => {
    const oldBaseline = baselineReceipt();
    delete oldBaseline.datasetContentSha256;
    const deps = selectorDeps({ dataset: datasetB, verifyOnly: true });
    const result = await execute(verifyInput({
      baseline: oldBaseline,
      marker: markerReceipt(oldBaseline),
    }), deps);

    assert.equal(result.status, "invalid_request");
    assert.equal(result.error.code, "invalid_request");
    assert.deepEqual(deps.calls, []);
  });

  await t.test("well-formed digest from dataset A mismatches dataset B", async () => {
    const deps = selectorDeps({ dataset: datasetB, verifyOnly: true });
    const result = await execute(verifyInput({
      baseline: baselineA,
      marker: markerReceipt(baselineA),
    }), deps);

    assert.equal(result.status, "invalid_request");
    assert.equal(result.error.code, "baseline_mismatch");
    assert.equal(result.baseline.datasetContentSha256, digestA);
    assert.equal(result.ranking, null);
    assert.deepEqual(deps.calls, []);
  });

  await t.test("malformed digest is an invalid request", async () => {
    const malformed = { ...baselineA, datasetContentSha256: "not-a-sha256" };
    const deps = selectorDeps({ dataset: datasetB, verifyOnly: true });
    const result = await execute(verifyInput({
      baseline: malformed,
      marker: markerReceipt(malformed),
    }), deps);

    assert.equal(result.status, "invalid_request");
    assert.equal(result.error.code, "invalid_request");
    assert.deepEqual(deps.calls, []);
  });
});

test("canonical dataset identity ignores object key order and source whitespace", () => {
  const dataset = homeEnvironmentDatasetSchema.parse(loadPackagedHomeEnvironmentDataset());
  const reverseKeys = (value) => {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
  };
  const reordered = reverseKeys(dataset);
  const reparsedPrettyJson = JSON.parse(JSON.stringify(dataset, null, 2));

  assert.equal(canonicalIdentity(reordered).sha256, canonicalIdentity(dataset).sha256);
  assert.equal(canonicalIdentity(reparsedPrettyJson).sha256, canonicalIdentity(dataset).sha256);
});

test("extension-absent legacy datasets receive the same canonical receipt binding", async () => {
  const legacy = structuredClone(loadPackagedHomeEnvironmentDataset());
  delete legacy.measurement.refreshProvenance;
  for (const environment of legacy.environments) {
    delete environment.guaranteedSurfaces;
    delete environment.extentClusters;
  }
  assert.equal(homeEnvironmentDatasetSchema.safeParse(legacy).success, true);
  const deps = selectorDeps({ dataset: legacy, hostResult: hostManual() });

  const result = await execute(switchInput(), deps);

  assert.equal(result.dataset.datasetContentSha256, canonicalIdentity(legacy).sha256);
  assert.equal(result.baseline.datasetContentSha256, result.dataset.datasetContentSha256);
});

test("every non-null validated baseline binds the top-level canonical dataset digest", async (t) => {
  const manual = await execute(switchInput(), selectorDeps({ hostResult: hostManual() }));
  assert.match(manual.dataset.datasetContentSha256, SNAPSHOT_RE);
  assert.equal(manual.baseline.datasetContentSha256, manual.dataset.datasetContentSha256);
  const proof = { baseline: manual.baseline, marker: manual.verification.marker };
  const noFitInput = verifyInput(proof, {
    requirements: [{ label: "TABLE", minimumExtentM: [99, 99] }],
  });
  const invalidInput = verifyInput({
    baseline: proof.baseline,
    marker: markerReceipt(proof.baseline, { serial: "emulator-5556" }),
  });
  const branches = [
    ["manual success", switchInput(), manual],
    ["selected success", switchInput(), await execute(switchInput(), selectorDeps())],
    ["verify no_fit", noFitInput, await execute(noFitInput, selectorDeps({ verifyOnly: true }))],
    ["verification failure", switchInput(), await execute(switchInput(), selectorDeps({ hostResult: hostFailed() }))],
    ["verify prevalidation failure", invalidInput, await execute(invalidInput, selectorDeps({ verifyOnly: true }))],
  ];

  for (const [name, input, result] of branches) {
    await t.test(name, async () => {
      assert.ok(result.baseline, `${name} must exercise a non-null baseline`);
      const changed = structuredClone(result);
      changed.baseline.datasetContentSha256 = result.dataset.datasetContentSha256 === "a".repeat(64)
        ? "b".repeat(64)
        : "a".repeat(64);
      assert.equal(selectHomeEnvironmentOutputSchema.safeParse(changed).success, false);

      let registration;
      const server = {
        registerTool(toolName, config, handler) {
          registration = { toolName, config, handler };
        },
      };
      registerHomeEnvironmentSelectorTools(server, async () => changed);
      await assert.rejects(registration.handler(input));
    });
  }
});

test("verify validates its receipt-bound baseline and marker before an impossible fit can return no_fit", async (t) => {
  const baseline = baselineReceipt();
  for (const [name, proof, expectedCode] of [
    ["baseline mismatch", {
      baseline: { ...baseline, expectedBuildReceiptId: "a".repeat(64) },
      marker: markerReceipt(baseline),
    }, "baseline_mismatch"],
    ["marker mismatch", {
      baseline,
      marker: markerReceipt(baseline, { serial: "emulator-5556" }),
    }, "marker_mismatch"],
  ]) {
    await t.test(name, async () => {
      const deps = selectorDeps({ verifyOnly: true });
      const result = await execute({
        action: "verify",
        requirements: [{ label: "TABLE", minimumExtentM: [99, 99] }],
        runtime: RUNTIME,
        baseline: proof.baseline,
        marker: proof.marker,
      }, deps);

      assert.equal(result.status, "invalid_request");
      assert.equal(result.error.code, expectedCode);
      assert.equal(result.ranking, null);
      assert.deepEqual(deps.calls, []);
    });
  }
});

test("rejects non-exclusive sources and action-specific runtime or baseline shapes before runtime calls", async (t) => {
  const baseline = {
    datasetId: "pico-emulator-6.0-home-environments-v1",
    datasetContentSha256: canonicalIdentity(
      homeEnvironmentDatasetSchema.parse(loadPackagedHomeEnvironmentDataset()),
    ).sha256,
    serial: SERIAL,
    packageName: PACKAGE_NAME,
    expectedBuildReceiptId: RECEIPT_ID,
    bootId: BOOT_ID,
    snapshotId: bedroomDayQuery.snapshotId,
  };
  for (const [name, input] of [
    ["non-string action resembling rank", { action: ["rank"], ...SOURCE }],
    ["both sources", { action: "rank", ...SOURCE, briefId: "swanmissiontable" }],
    ["no source", { action: "rank" }],
    ["rank runtime", { action: "rank", ...SOURCE, runtime: RUNTIME }],
    ["rank marker", { action: "rank", ...SOURCE, marker: markerReceipt(baseline) }],
    ["switch missing runtime", { action: "switch", ...SOURCE }],
    ["switch baseline", { action: "switch", ...SOURCE, runtime: RUNTIME, baseline }],
    ["switch marker", { action: "switch", ...SOURCE, runtime: RUNTIME, marker: markerReceipt(baseline) }],
    ["verify missing baseline", { action: "verify", ...SOURCE, runtime: RUNTIME }],
  ]) {
    await t.test(name, async () => {
      const deps = selectorDeps();
      const result = await execute(input, deps);
      assert.equal(result.status, "invalid_request");
      assert.deepEqual(deps.calls, []);
    });
  }
});

test("switch takes a receipt-bound pre-baseline before the marker and returns it on a manual guard", async () => {
  const deps = selectorDeps({ hostResult: hostManual("Accessibility permission denied") });
  const result = await execute(switchInput(), deps);

  assert.equal(result.status, "manual_switch_required");
  assert.equal(result.hostSelection.status, "manual_switch_required");
  assert.equal(result.hostSelection.baselineSafe, true);
  assert.deepEqual(result.baseline, {
    datasetId: "pico-emulator-6.0-home-environments-v1",
    datasetContentSha256: canonicalIdentity(
      homeEnvironmentDatasetSchema.parse(loadPackagedHomeEnvironmentDataset()),
    ).sha256,
    serial: SERIAL,
    packageName: PACKAGE_NAME,
    expectedBuildReceiptId: RECEIPT_ID,
    bootId: BOOT_ID,
    snapshotId: bedroomDayQuery.snapshotId,
  });
  assert.deepEqual(deps.calls, ["observe-pre", "query-pre", "mark", "host-select"]);
  assert.equal(result.verification.marker.nonce, result.baseline.snapshotId);
  assert.equal(result.verification.preQuery.snapshotId, result.baseline.snapshotId);
  assert.equal(result.verification.postQuery, null);
});

test("manual host result cannot redirect the proposed target", async () => {
  const deps = selectorDeps({
    hostResult: { ...hostManual(), targetTile: "Bedroom Day" },
  });
  const result = await execute(switchInput(), deps);

  assert.equal(result.status, "verification_failed");
  assert.equal(result.error.code, "host_selection_wrong_target");
  assert.equal(result.selectedTarget, "Livingroom Day");
  assert.deepEqual(deps.calls, ["observe-pre", "query-pre", "mark", "host-select"]);
});

test("host click/hash observation failure is verification_failed and never queries a post mesh", async () => {
  const deps = selectorDeps({ hostResult: hostFailed() });
  const result = await execute(switchInput(), deps);

  assert.equal(result.status, "verification_failed");
  assert.equal(result.error.code, "host_selection_not_observed");
  assert.ok(result.baseline);
  assert.deepEqual(deps.calls, ["observe-pre", "query-pre", "mark", "host-select"]);
});

test("unique target success preserves exact live call order and production query policy", async () => {
  const deps = selectorDeps();
  const result = await execute(switchInput(), deps);

  assert.deepEqual(deps.calls, [
    "observe-pre",
    "query-pre",
    "mark",
    "host-select",
    "observe-post",
    "query-post",
  ]);
  assert.equal(result.status, "selected_verified");
  assert.notEqual(result.verification.preSnapshotId, result.verification.postSnapshotId);
  assert.equal(result.verification.classification.environment.tile, "Livingroom Day");
  assert.equal(result.verification.sceneIdentityRole, "coarse_consistency_only_non_discriminating");
  assert.deepEqual(deps.queryInputs, [0, 1].map(() => ({
    serial: SERIAL,
    scenario: {
      packageName: PACKAGE_NAME,
      expectedBuildReceiptId: RECEIPT_ID,
      expectedStageStyle: "Mixed",
      expectedRootContainer: "stage",
      sceneDriftPolicy: {
        count: "advisory",
        maxTransformDeltaM: 0.01,
        maxTransformDeltaDeg: 1,
        maxExtentDeltaM: 0.01,
        topology: "strict",
      },
    },
    labels: ["TABLE", "FLOOR", "WALL_ART"],
    maxRetries: 15,
    pollMs: 1000,
    includeGeometry: "lossless_external_artifact",
    stabilityReads: 2,
  })));
  assert.equal(deps.hostInputs[0].selectionTarget.serial, SERIAL);
  assert.equal(deps.hostInputs[0].selectionTarget.tile, "Livingroom Day");
});

test("mission selection verifies the globally ranked preferred tier against the live post mesh", async (t) => {
  const floorOnlyPost = withRuntime(livingroomDayRefresh4Query, RUNTIME);

  await t.test("fails when accepted identity and clusters expose only fallback FLOOR live", async () => {
    const result = await execute(missionSwitchInput(), selectorDeps({ postQuery: floorOnlyPost }));

    assert.equal(result.status, "verification_failed");
    assert.equal(result.selectedTarget, "Livingroom Day");
    assert.equal(result.failurePhase, "classification");
    assert.equal(result.error.code, "classification_extent_mismatch");
    assert.deepEqual(result.verification.classification.histogramMatches, ["Livingroom Day"]);
    assert.equal(result.verification.classification.predicates.surfaceExtentMultisetsMatch, true);
    assert.equal(result.verification.classification.predicates.requirementsFit, false);
  });

  await t.test("passes the authoritative holdout shape when the preferred TABLE is live", async () => {
    const preferredPost = querySceneAnchorsOutputSchema.parse(
      committedLiveHoldout2.response.structuredContent.verification.postQuery,
    );
    const result = await execute(
      missionSwitchInput({ runtime: LIVE_RUNTIME }),
      selectorDeps({
        preQuery: completeLabelAbsentPreQuery,
        postQuery: preferredPost,
      }),
    );

    assert.equal(result.status, "selected_verified");
    assert.equal(result.selectedTarget, "Livingroom Day");
    assert.equal(result.verification.classification.environment.tile, "Livingroom Day");
    assert.equal(result.verification.classification.predicates.surfaceExtentMultisetsMatch, true);
    assert.equal(result.verification.classification.predicates.requirementsFit, true);
  });
});

test("ordinary switch passes and retains the exact produced marker object", async () => {
  const observedAtEpochSeconds = MARKER_EPOCH + 5;
  const rawLine = markerRawLine(bedroomDayQuery.snapshotId, { epoch: observedAtEpochSeconds });
  const deps = selectorDeps({ markerOverrides: { observedAtEpochSeconds, rawLine } });

  const result = await execute(switchInput(), deps);

  assert.equal(result.status, "selected_verified");
  assert.deepEqual(result.verification.marker, markerReceipt(result.baseline, {
    observedAtEpochSeconds,
    rawLine,
  }));
  assert.deepEqual(deps.calls, [
    "observe-pre",
    "query-pre",
    "mark",
    "host-select",
    "observe-post",
    "query-post",
  ]);
});

test("a complete live-derived label_absent pre snapshot can switch to selected_verified", async () => {
  const deps = selectorDeps({
    preQuery: completeLabelAbsentPreQuery,
    postQuery: withRuntime(livingroomDayQuery, LIVE_RUNTIME),
  });

  const result = await execute(switchInput({ runtime: LIVE_RUNTIME }), deps);

  assert.equal(result.status, "selected_verified");
  assert.equal(result.verification.preQuery.status, "label_absent");
  assert.equal(result.verification.preQuery.error.code, "label_absent");
  assert.equal(result.baseline.snapshotId, completeLabelAbsentPreQuery.snapshotId);
  assert.equal(result.verification.postQuery.status, "ready");
  assert.deepEqual(deps.calls, ["observe-pre", "query-pre", "mark", "host-select", "observe-post", "query-post"]);
});

test("a complete label_absent pre snapshot propagates through manual and failure receipt frontiers", async (t) => {
  await t.test("manual switch retains the complete baseline", async () => {
    const deps = selectorDeps({
      preQuery: completeLabelAbsentPreQuery,
      postQuery: withRuntime(livingroomDayQuery, LIVE_RUNTIME),
      hostResult: hostManual(),
    });
    const result = await execute(switchInput({ runtime: LIVE_RUNTIME }), deps);

    assert.equal(result.status, "manual_switch_required");
    assert.equal(result.baseline.snapshotId, completeLabelAbsentPreQuery.snapshotId);
    assert.equal(result.verification.preQuery.status, "label_absent");
    assert.deepEqual(deps.calls, ["observe-pre", "query-pre", "mark", "host-select"]);
  });

  await t.test("downstream host failure remains causally bound to the complete baseline", async () => {
    const deps = selectorDeps({
      preQuery: completeLabelAbsentPreQuery,
      postQuery: withRuntime(livingroomDayQuery, LIVE_RUNTIME),
      hostResult: hostFailed(),
    });
    const result = await execute(switchInput({ runtime: LIVE_RUNTIME }), deps);

    assert.equal(result.status, "verification_failed");
    assert.equal(result.failurePhase, "host_selection");
    assert.equal(result.error.code, "host_selection_not_observed");
    assert.equal(result.baseline.snapshotId, completeLabelAbsentPreQuery.snapshotId);
    assert.deepEqual(deps.calls, ["observe-pre", "query-pre", "mark", "host-select"]);
  });
});

test("a complete label_absent snapshot remains a hard post-query failure", async () => {
  const deps = selectorDeps({
    preQuery: completeLabelAbsentPreQuery,
    postQuery: completeLabelAbsentPreQuery,
  });

  const result = await execute(switchInput({ runtime: LIVE_RUNTIME }), deps);

  assert.equal(result.status, "verification_failed");
  assert.equal(result.failurePhase, "post_query");
  assert.equal(result.error.code, "bridge_label_absent");
  assert.equal(result.verification.classification, null);
  assert.deepEqual(deps.calls, ["observe-pre", "query-pre", "mark", "host-select", "observe-post", "query-post"]);
});

test("complete label_absent pre snapshots fail closed under completeness mutations", async (t) => {
  const mutations = [
    ["missing snapshot", "snapshot_missing", (query) => { query.snapshotId = null; }],
    ["missing binding", "identity_drift_binding", (query) => { query.applicationRuntimeBinding = null; }],
    ["serial identity drift", "identity_drift_serial", (query) => {
      query.applicationRuntimeBinding.serial = "emulator-5556";
      query.applicationRuntimeBinding.liveIdentity.serial = "emulator-5556";
    }],
    ["non-emulator boot identity", "bridge_label_absent", (query) => {
      query.applicationRuntimeBinding.liveIdentity.bootQemu = "0";
    }],
    ["APK binding receipt mismatch", "bridge_label_absent", (query) => {
      const bindingReceipt = query.actionReceipts.find((receipt) => receipt.action === "bind_application_runtime");
      bindingReceipt.ack.apkSha256 = "a".repeat(64);
    }],
    ["configured drift policy mismatch", "scene_drift_policy_mismatch", (query) => {
      query.applicationRuntimeBinding.effectiveSceneDriftPolicy.maxExtentDeltaM = 0.02;
    }],
    ["drift outside policy", "scene_drift_out_of_policy", (query) => {
      query.drift.withinPolicy = false;
      query.drift.maxTransformDeltaM = 0.02;
    }],
    ["contradictory within-policy drift metrics", "bridge_label_absent", (query) => {
      query.drift.maxTransformDeltaM = 0.02;
    }],
    ["missing geometry", "bridge_label_absent", (query) => { query.geometryRef = null; }],
    ["missing geometry publication", "bridge_label_absent", (query) => {
      query.actionReceipts = query.actionReceipts.filter((receipt) => receipt.action !== "publish_geometry");
    }],
    ["mismatched geometry publication", "bridge_label_absent", (query) => {
      const publication = query.actionReceipts.find((receipt) => receipt.action === "publish_geometry");
      publication.ack.sha256 = "a".repeat(64);
    }],
    ["missing stable-read retry evidence", "bridge_label_absent", (query) => { query.retries = 0; }],
    ["missing stable-read drift evidence", "bridge_label_absent", (query) => { query.drift.deltas = []; }],
  ];

  for (const [name, errorCode, mutate] of mutations) {
    await t.test(name, async () => {
      const preQuery = structuredClone(completeLabelAbsentPreQuery);
      mutate(preQuery);
      const deps = selectorDeps({
        preQuery,
        postQuery: withRuntime(livingroomDayQuery, LIVE_RUNTIME),
      });

      const result = await execute(switchInput({ runtime: LIVE_RUNTIME }), deps);

      assert.equal(result.status, "verification_failed");
      assert.equal(result.failurePhase, "pre_query");
      assert.equal(result.error.code, errorCode);
      assert.equal(result.baseline, null);
      assert.deepEqual(deps.calls, ["observe-pre", "query-pre"]);
    });
  }
});

test("ready post snapshots fail closed under every receipt-completeness omission", async (t) => {
  for (const [name, mutate] of POST_SNAPSHOT_COMPLETENESS_MUTATIONS) {
    await t.test(name, async () => {
      const postQuery = withRuntime(livingroomDayQuery, LIVE_RUNTIME);
      mutate(postQuery);
      const deps = selectorDeps({
        preQuery: completeLabelAbsentPreQuery,
        postQuery,
      });

      const result = await execute(switchInput({ runtime: LIVE_RUNTIME }), deps);

      assert.equal(result.status, "verification_failed");
      assert.equal(result.failurePhase, "post_query");
      assert.equal(result.error.code, "bridge_result_invalid");
      assert.equal(result.verification.classification, null);
      assert.deepEqual(deps.calls, ["observe-pre", "query-pre", "mark", "host-select", "observe-post", "query-post"]);
    });
  }

  await t.test("manual verify action enforces the same complete post-query receipt", async () => {
    const proof = await manualProof();
    const postQuery = mutateReady(livingroomDayQuery, (query) => { query.geometryRef = null; });
    const deps = selectorDeps({ verifyOnly: true, postQuery });

    const result = await execute(verifyInput(proof), deps);

    assert.equal(result.status, "verification_failed");
    assert.equal(result.failurePhase, "post_query");
    assert.equal(result.error.code, "bridge_result_invalid");
    assert.equal(result.verification.classification, null);
    assert.deepEqual(deps.calls, ["observe-post", "query-post"]);
  });

  await t.test("unchanged snapshot keeps its more specific causal code when also incomplete", async () => {
    const postQuery = mutateReady(bedroomDayQuery, (query) => { query.geometryRef = null; });
    const deps = selectorDeps({ postQuery });

    const result = await execute(switchInput(), deps);

    assert.equal(result.status, "verification_failed");
    assert.equal(result.failurePhase, "post_query");
    assert.equal(result.error.code, "snapshot_unchanged");
    assert.equal(result.verification.classification, null);
  });
});

test("label_absent pre snapshots require coherent two-read drift and external geometry", async (t) => {
  const mutations = [
    ["all per-anchor drift transitions removed", (query) => {
      query.drift.deltas = query.drift.deltas.filter((delta) => delta.metric !== "anchor");
    }],
    ["one per-anchor drift transition removed", (query) => {
      const removed = query.drift.deltas.findIndex((delta) => delta.metric === "anchor");
      query.drift.deltas.splice(removed, 1);
    }],
    ["top-level count delta contradicts anchor-count delta", (query) => {
      query.drift.countDelta = 17;
    }],
    ["anchor-count delta contradicts summary", (query) => {
      query.drift.deltas.find((delta) => delta.metric === "anchor_count").value = 17;
    }],
    ["anchor-count policy contradicts effective policy", (query) => {
      query.drift.deltas.find((delta) => delta.metric === "anchor_count").policy = "strict";
    }],
    ["summary maximum contradicts per-anchor deltas", (query) => {
      query.drift.maxTransformDeltaM = 0.005;
    }],
    ["per-anchor label-change flag contradicts its labels", (query) => {
      query.drift.deltas.find((delta) => delta.metric === "anchor").previousLabels = ["CEILING"];
    }],
    ["duplicate per-anchor transition leaves incomplete previous coverage", (query) => {
      const anchorDeltas = query.drift.deltas.filter((delta) => delta.metric === "anchor");
      anchorDeltas.at(-1).previousIndex = anchorDeltas[0].previousIndex;
    }],
    ["relative geometry artifact path", (query) => {
      query.geometryRef.path = "relative-geometry.json";
      query.actionReceipts.find((receipt) => receipt.action === "publish_geometry").ack.path = query.geometryRef.path;
    }],
    ["repository-internal geometry artifact path", (query) => {
      const binding = query.applicationRuntimeBinding;
      query.geometryRef.path = path.join(
        repoRoot,
        ".selector-review",
        "pico-scene-session-review00",
        `scene-${binding.bridgeRevision}-${binding.requestId}.json`,
      );
      query.actionReceipts.find((receipt) => receipt.action === "publish_geometry").ack.path = query.geometryRef.path;
    }],
  ];

  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const preQuery = structuredClone(completeLabelAbsentPreQuery);
      mutate(preQuery);
      const deps = selectorDeps({
        preQuery,
        postQuery: withRuntime(livingroomDayQuery, LIVE_RUNTIME),
        hostResult: hostManual(),
      });

      const result = await execute(switchInput({ runtime: LIVE_RUNTIME }), deps);

      assert.equal(result.status, "verification_failed");
      assert.equal(result.failurePhase, "pre_query");
      assert.equal(result.error.code, "bridge_label_absent");
      assert.equal(result.baseline, null);
      assert.deepEqual(deps.calls, ["observe-pre", "query-pre"]);
    });
  }
});

test("label_absent pre-query errors must be present and exact", async (t) => {
  for (const [name, mutate] of [
    ["null", (query) => { query.error = null; }],
    ["wrong", (query) => { query.error = { code: "not_ready", detail: "contradictory terminal code" }; }],
    ["missing", (query) => { delete query.error; }],
  ]) {
    await t.test(name, async () => {
      const preQuery = structuredClone(completeLabelAbsentPreQuery);
      mutate(preQuery);
      const deps = selectorDeps({ preQuery });

      const result = await execute(switchInput({ runtime: LIVE_RUNTIME }), deps);

      assert.equal(result.status, "verification_failed");
      assert.equal(result.failurePhase, "pre_query");
      assert.equal(result.error.code, "bridge_result_invalid");
      assert.equal(result.verification.preQuery, null);
      assert.deepEqual(deps.calls, ["observe-pre", "query-pre"]);
    });
  }

  const selected = await execute(
    switchInput({ runtime: LIVE_RUNTIME }),
    selectorDeps({
      preQuery: completeLabelAbsentPreQuery,
      postQuery: withRuntime(livingroomDayQuery, LIVE_RUNTIME),
    }),
  );
  for (const [name, mutate] of [
    ["null refined receipt", (query) => { query.error = null; }],
    ["wrong refined receipt", (query) => { query.error.code = "not_ready"; }],
    ["missing refined receipt", (query) => { delete query.error; }],
  ]) {
    await t.test(name, () => {
      const impossible = structuredClone(selected);
      mutate(impossible.verification.preQuery);
      assert.equal(selectHomeEnvironmentOutputSchema.safeParse(impossible).success, false);
    });
  }
});

test("output schema strictly validates the classified environment receipt", async () => {
  const result = await execute(switchInput(), selectorDeps());
  assert.equal(result.status, "selected_verified");
  assert.deepEqual(Object.keys(result).sort(), [
    "action", "baseline", "dataset", "error", "evidenceCeiling", "failurePhase",
    "hostSelection", "ranking", "requirements", "selectedTarget", "status", "verification",
  ]);
  assert.deepEqual(Object.keys(result.dataset).sort(), [
    "capabilitySummarySha256", "datasetContentSha256", "datasetId", "measuredAt", "schemaVersion", "selectionProvenanceSha256",
    "sourceCommit", "sourcePath",
  ]);
  assert.equal(selectHomeEnvironmentOutputSchema.safeParse(result).success, true);
  result.verification.classification.environment.unexpectedIdentityHint = "host-click";

  const checked = selectHomeEnvironmentOutputSchema.safeParse(result);
  assert.equal(checked.success, false);
});

test("selected_verified schema rejects every incomplete post-query receipt class", async (t) => {
  const selected = await execute(
    switchInput({ runtime: LIVE_RUNTIME }),
    selectorDeps({
      preQuery: completeLabelAbsentPreQuery,
      postQuery: withRuntime(livingroomDayQuery, LIVE_RUNTIME),
    }),
  );
  assert.equal(selected.status, "selected_verified");

  for (const [name, mutate] of POST_SNAPSHOT_COMPLETENESS_MUTATIONS) {
    await t.test(name, () => {
      const impossible = structuredClone(selected);
      mutate(impossible.verification.postQuery);
      assert.equal(selectHomeEnvironmentOutputSchema.safeParse(impossible).success, false);
    });
  }
});

test("authoritative Livingroom holdout receipt satisfies the complete final output contract", () => {
  assert.equal(committedLiveHoldout2.schemaVersion, 1);
  assert.equal(committedLiveHoldout2.kind, "pico.home-environment-selector-holdout-call");
  assert.equal(committedLiveHoldout2.phase, "verify");
  assert.deepEqual(
    JSON.parse(committedLiveHoldout2.response.content[0].text),
    committedLiveHoldout2.response.structuredContent,
  );
  const selected = selectHomeEnvironmentOutputSchema.parse(
    committedLiveHoldout2.response.structuredContent,
  );
  const baseline = selected.baseline;
  const verification = selected.verification;
  const post = selected.verification.postQuery;

  assert.equal(selected.status, "selected_verified");
  assert.equal(selected.action, "verify");
  assert.equal(selected.selectedTarget, "Livingroom Day");
  assert.equal(selected.hostSelection, null);
  assert.equal(selected.failurePhase, null);
  assert.equal(selected.error, null);
  assert.equal(baseline.datasetId, selected.dataset.datasetId);
  assert.equal(baseline.datasetContentSha256, selected.dataset.datasetContentSha256);
  assert.equal(baseline.snapshotId, verification.preSnapshotId);
  assert.equal(baseline.snapshotId, verification.marker.nonce);
  assert.equal(baseline.serial, verification.marker.serial);
  assert.equal(baseline.serial, verification.runtime.serial);
  assert.equal(baseline.packageName, verification.runtime.packageName);
  assert.equal(baseline.expectedBuildReceiptId, verification.runtime.expectedBuildReceiptId);
  assert.equal(verification.preWorldSpaceAttempt, null);
  assert.equal(verification.preQuery, null);
  assert.equal(verification.postSnapshotId, post.snapshotId);
  assert.notEqual(verification.postSnapshotId, verification.preSnapshotId);
  assert.equal(verification.target.tile, selected.selectedTarget);
  assert.equal(selected.ranking.selectedTarget, selected.selectedTarget);
  assert.equal(verification.classification.environment.tile, selected.selectedTarget);
  assert.deepEqual(verification.classification.histogramMatches, [selected.selectedTarget]);
  assert.equal(verification.sceneIdentityRole, "coarse_consistency_only_non_discriminating");
  assert.deepEqual(verification.classification.predicates, {
    bridgeStatus: "ready",
    missingRequestedLabels: [],
    surfaceExtentMultisetsMatch: true,
    requirementsFit: true,
  });
  assert.equal(post.status, "ready");
  assert.equal(post.applicationRuntimeBinding.liveIdentity.bootQemu, "1");
  assert.deepEqual(post.requestedLabels, ["FLOOR", "TABLE", "WALL_ART"]);
  assert.deepEqual(post.actionReceipts.map((receipt) => receipt.action), [
    "bind_application_runtime",
    "bridge_broadcast",
    "bridge_payload_pull",
    "bridge_payload_cleanup",
    "publish_geometry",
  ]);
  assert.ok(post.geometryRef.bytes > 0);
  assert.ok(post.drift.deltas.length > 0);

  for (const [name, mutate] of POST_SNAPSHOT_COMPLETENESS_MUTATIONS) {
    const incomplete = structuredClone(selected);
    mutate(incomplete.verification.postQuery);
    assert.equal(
      selectHomeEnvironmentOutputSchema.safeParse(incomplete).success,
      false,
      name,
    );
  }
});

test("output schema rejects missing markers and forged pre/marker/post ordering", async (t) => {
  const manual = await execute(switchInput(), selectorDeps({ hostResult: hostManual() }));
  const selectedSwitch = await execute(switchInput(), selectorDeps());
  const proof = {
    baseline: manual.baseline,
    marker: manual.verification.marker,
  };
  const selectedVerify = await execute(verifyInput(proof), selectorDeps({ verifyOnly: true }));
  const verifyPostFailure = await execute(
    verifyInput(proof),
    selectorDeps({ verifyOnly: true, postQuery: bedroomDayQuery }),
  );

  const manualReordered = structuredClone(manual);
  const preEpoch = manualReordered.verification.preWorldSpaceAttempt.observation.observedAtEpochSeconds;
  manualReordered.verification.marker.observedAtEpochSeconds = preEpoch;
  manualReordered.verification.marker.rawLine = markerRawLine(manualReordered.baseline.snapshotId, { epoch: preEpoch });

  const switchPostReordered = structuredClone(selectedSwitch);
  switchPostReordered.verification.postWorldSpaceAttempt.observation = observation({
    observedAtEpochSeconds: switchPostReordered.verification.marker.observedAtEpochSeconds,
  });

  const verifyMarkerMissing = structuredClone(selectedVerify);
  verifyMarkerMissing.verification.marker = null;

  const verifyRawEpochForged = structuredClone(selectedVerify);
  verifyRawEpochForged.verification.postWorldSpaceAttempt.observation.observedAtEpochSeconds =
    verifyRawEpochForged.verification.marker.observedAtEpochSeconds + 1;

  const verifyFailureMarkerMissing = structuredClone(verifyPostFailure);
  verifyFailureMarkerMissing.verification.marker = null;

  for (const [name, impossible] of [
    ["switch marker is not later than pre WorldSpace", manualReordered],
    ["switch post WorldSpace is not later than marker", switchPostReordered],
    ["selected verify marker is missing", verifyMarkerMissing],
    ["selected verify post epoch contradicts raw row", verifyRawEpochForged],
    ["verify post failure marker is missing", verifyFailureMarkerMissing],
  ]) {
    await t.test(name, () => {
      assert.equal(selectHomeEnvironmentOutputSchema.safeParse(impossible).success, false);
    });
  }
});

test("coarse-scene post failures require a coherent observation strictly newer than the exact marker", async (t) => {
  const proof = await manualProof();
  const cases = [
    {
      name: "switch",
      input: switchInput(),
      result: await execute(
        switchInput(),
        selectorDeps({ postObservation: observation({ sceneId: "AnotherCoarseScene" }) }),
      ),
    },
    {
      name: "verify",
      input: verifyInput(proof),
      result: await execute(
        verifyInput(proof),
        selectorDeps({
          verifyOnly: true,
          postObservation: observation({ sceneId: "AnotherCoarseScene" }),
        }),
      ),
    },
  ];

  for (const { name, input, result } of cases) {
    assert.equal(result.status, "verification_failed");
    assert.equal(result.failurePhase, "post_world_space");
    assert.equal(result.error.code, "coarse_scene_mismatch");
    for (const [relation, epoch] of [
      ["equal", result.verification.marker.observedAtEpochSeconds],
      ["before", result.verification.marker.observedAtEpochSeconds - 1],
    ]) {
      const impossible = structuredClone(result);
      impossible.verification.postWorldSpaceAttempt.observation = observation({
        observedAtEpochSeconds: epoch,
        sceneId: "AnotherCoarseScene",
      });

      await t.test(`${name} schema rejects a coherent ${relation}-marker observation`, () => {
        assert.equal(selectHomeEnvironmentOutputSchema.safeParse(impossible).success, false);
      });
      await t.test(`${name} registered handler rejects a coherent ${relation}-marker observation`, async () => {
        let registration;
        const server = {
          registerTool(toolName, config, handler) {
            registration = { toolName, config, handler };
          },
        };
        registerHomeEnvironmentSelectorTools(server, async () => impossible);
        await assert.rejects(registration.handler(input));
      });
    }
  }
});

test("output schema enforces status, action, and receipt relationships", async (t) => {
  const ranked = await execute({ action: "rank", ...SOURCE }, selectorDeps());
  const noFit = await execute({
    action: "switch",
    requirements: [{ label: "TABLE", minimumExtentM: [99, 99] }],
    runtime: RUNTIME,
  }, selectorDeps());
  const invalid = await execute({ action: "rank" }, selectorDeps());
  const manual = await execute(switchInput(), selectorDeps({ hostResult: hostManual() }));
  const selected = await execute(switchInput(), selectorDeps());
  const failed = await execute(switchInput(), selectorDeps({ hostResult: hostFailed() }));

  const realResults = [ranked, noFit, invalid, manual, selected, failed];
  for (const result of realResults) {
    assert.equal(selectHomeEnvironmentOutputSchema.safeParse(result).success, true, result.status);
  }

  const statuses = realResults.map((result) => result.status);
  for (const source of realResults) {
    for (const status of statuses.filter((candidate) => candidate !== source.status)) {
      await t.test(`${source.status} cannot masquerade as ${status}`, () => {
        const result = structuredClone(source);
        result.status = status;
        result.error = status === "invalid_request"
          ? structuredClone(invalid.error)
          : status === "verification_failed"
            ? structuredClone(failed.error)
            : null;
        assert.equal(selectHomeEnvironmentOutputSchema.safeParse(result).success, false);
      });
    }
  }

  const allowedActions = {
    ranked: ["rank"],
    no_fit: ["rank", "switch", "verify"],
    invalid_request: [null, "rank", "switch", "verify"],
    manual_switch_required: ["switch"],
    selected_verified: ["switch", "verify"],
    verification_failed: ["switch", "verify"],
  };
  for (const source of realResults) {
    for (const action of [null, "rank", "switch", "verify"].filter(
      (candidate) => !allowedActions[source.status].includes(candidate),
    )) {
      await t.test(`${source.status} rejects ${String(action)} action`, () => {
        const result = { ...structuredClone(source), action };
        assert.equal(selectHomeEnvironmentOutputSchema.safeParse(result).success, false);
      });
    }
  }

  const impossible = [
    ["invalid_request with completed ranking", {
      ...structuredClone(ranked),
      status: "invalid_request",
      error: structuredClone(invalid.error),
    }],
    ["invalid_request with runtime success receipts", {
      ...structuredClone(invalid),
      baseline: structuredClone(selected.baseline),
      hostSelection: structuredClone(selected.hostSelection),
      verification: structuredClone(selected.verification),
    }],
    ["selected_verified with rank action", { ...structuredClone(selected), action: "rank" }],
    ["selected_verified without baseline", { ...structuredClone(selected), baseline: null }],
    ["selected_verified without verification", { ...structuredClone(selected), verification: null }],
    ["ranked with runtime receipts", {
      ...structuredClone(ranked),
      baseline: structuredClone(selected.baseline),
      hostSelection: structuredClone(selected.hostSelection),
      verification: structuredClone(selected.verification),
    }],
    ["manual without baseline", { ...structuredClone(manual), baseline: null }],
    ["manual without host receipt", { ...structuredClone(manual), hostSelection: null }],
    ["manual with observed host receipt", { ...structuredClone(manual), hostSelection: structuredClone(selected.hostSelection) }],
    ["verification_failed without error receipt", { ...structuredClone(failed), error: null }],
    ["verification_failed without verification receipt", { ...structuredClone(failed), verification: null }],
  ];
  for (const [name, result] of impossible) {
    await t.test(name, () => {
      assert.equal(selectHomeEnvironmentOutputSchema.safeParse(result).success, false);
    });
  }
});

test("registered handler rejects an impossible refined output before structuredContent escapes", async () => {
  const ranked = await execute({ action: "rank", ...SOURCE }, selectorDeps());
  const impossible = {
    ...structuredClone(ranked),
    status: "invalid_request",
    error: { code: "invalid_request", detail: "synthetic impossible output" },
  };
  let registration;
  const server = {
    registerTool(name, config, handler) {
      registration = { name, config, handler };
    },
  };

  registerHomeEnvironmentSelectorTools(server, async () => impossible);

  assert.equal(registration.name, "select_home_environment");
  assert.ok(registration.config.outputSchema);
  await assert.rejects(
    registration.handler({ action: "rank", ...SOURCE }),
    /invalid_request cannot carry normalized requirements|invalid_request cannot carry a ranking receipt/,
  );
});

test("registered verify binds every returned marker field to the exact caller receipt", async (t) => {
  const proof = await manualProof();
  const input = verifyInput(proof);
  const selected = await execute(input, selectorDeps({ verifyOnly: true }));
  const swapped = structuredClone(selected);
  const swappedEpoch = proof.marker.observedAtEpochSeconds + 1;
  swapped.verification.marker = markerReceipt(proof.baseline, {
    observedAtEpochSeconds: swappedEpoch,
    rawLine: markerRawLine(proof.baseline.snapshotId, { epoch: swappedEpoch }),
  });
  assert.equal(selectHomeEnvironmentOutputSchema.safeParse(swapped).success, true);

  await t.test("rejects a coherent same-nonce epoch/raw-row swap before content escapes", async () => {
    let registration;
    const server = {
      registerTool(toolName, config, handler) {
        registration = { toolName, config, handler };
      },
    };
    registerHomeEnvironmentSelectorTools(server, async () => swapped);
    await assert.rejects(
      registration.handler(input),
      /exact caller marker/,
    );
  });

  await t.test("preserves a valid no-fit verify output with no marker receipt", async () => {
    const noFitInput = verifyInput(proof, {
      requirements: [{ label: "TABLE", minimumExtentM: [99, 99] }],
    });
    const noFit = await execute(noFitInput, selectorDeps({ verifyOnly: true }));
    assert.equal(noFit.status, "no_fit");
    assert.equal(noFit.verification, null);
    let registration;
    const server = {
      registerTool(toolName, config, handler) {
        registration = { toolName, config, handler };
      },
    };
    registerHomeEnvironmentSelectorTools(server, async () => noFit);
    const response = await registration.handler(noFitInput);
    assert.deepEqual(response.structuredContent, noFit);
  });

  await t.test("preserves a relational pre-validation failure with no marker receipt", async () => {
    const invalidInput = verifyInput({
      baseline: proof.baseline,
      marker: markerReceipt(proof.baseline, { serial: "emulator-5556" }),
    });
    const invalid = await execute(invalidInput, selectorDeps({ verifyOnly: true }));
    assert.equal(invalid.status, "invalid_request");
    assert.equal(invalid.verification, null);
    let registration;
    const server = {
      registerTool(toolName, config, handler) {
        registration = { toolName, config, handler };
      },
    };
    registerHomeEnvironmentSelectorTools(server, async () => invalid);
    const response = await registration.handler(invalidInput);
    assert.deepEqual(response.structuredContent, invalid);
  });
});

test("registered boundary binds the returned envelope to the exact parsed request", async (t) => {
  const invokeRegistered = (returned, input) => {
    let registration;
    const server = {
      registerTool(toolName, config, handler) {
        registration = { toolName, config, handler };
      },
    };
    registerHomeEnvironmentSelectorTools(server, async () => returned);
    return registration.handler(input);
  };

  const manual = await execute(switchInput(), selectorDeps({ hostResult: hostManual() }));
  const manualProofReceipt = {
    baseline: structuredClone(manual.baseline),
    marker: structuredClone(manual.verification.marker),
  };
  const verifyRequest = verifyInput(manualProofReceipt);

  await t.test("rejects a verify request paired with a schema-valid switch result", async () => {
    await assert.rejects(
      invokeRegistered(manual, verifyRequest),
      /caller action/,
    );
  });

  await t.test("binds actions for non-verify calls too", async () => {
    const rankInput = {
      action: "rank",
      requirements: [{ label: "TABLE", minimumExtentM: [99, 99] }],
    };
    const rankNoFit = await execute(rankInput, selectorDeps());
    const switchNoFit = structuredClone(rankNoFit);
    switchNoFit.action = "switch";
    assert.equal(selectHomeEnvironmentOutputSchema.safeParse(switchNoFit).success, true);
    await assert.rejects(
      invokeRegistered(switchNoFit, rankInput),
      /caller action/,
    );
  });

  await t.test("rejects a same-action verify runtime substitution", async () => {
    const missing = await execute(
      verifyRequest,
      selectorDeps({ verifyOnly: true, postObservation: null }),
    );
    const swappedRuntime = structuredClone(missing);
    swappedRuntime.verification.runtime.expectedStageStyle = "Full";
    assert.equal(selectHomeEnvironmentOutputSchema.safeParse(swappedRuntime).success, true);
    await assert.rejects(
      invokeRegistered(swappedRuntime, verifyRequest),
      /caller runtime/,
    );
  });

  await t.test("rejects a markerless no-fit baseline substitution", async () => {
    const noFitInput = verifyInput(manualProofReceipt, {
      requirements: [{ label: "TABLE", minimumExtentM: [99, 99] }],
    });
    const noFit = await execute(noFitInput, selectorDeps({ verifyOnly: true }));
    const swappedBaseline = structuredClone(noFit);
    swappedBaseline.baseline.bootId = "another-boot";
    assert.equal(selectHomeEnvironmentOutputSchema.safeParse(swappedBaseline).success, true);
    await assert.rejects(
      invokeRegistered(swappedBaseline, noFitInput),
      /caller baseline/,
    );
  });

  await t.test("rejects a coherent dataset-digest substitution against the exact caller baseline", async () => {
    const noFitInput = verifyInput(manualProofReceipt, {
      requirements: [{ label: "TABLE", minimumExtentM: [99, 99] }],
    });
    const noFit = await execute(noFitInput, selectorDeps({ verifyOnly: true }));
    const swappedDigest = noFit.dataset.datasetContentSha256 === "a".repeat(64)
      ? "b".repeat(64)
      : "a".repeat(64);
    const swappedBaseline = structuredClone(noFit);
    swappedBaseline.dataset.datasetContentSha256 = swappedDigest;
    swappedBaseline.baseline.datasetContentSha256 = swappedDigest;
    assert.equal(selectHomeEnvironmentOutputSchema.safeParse(swappedBaseline).success, true);
    await assert.rejects(
      invokeRegistered(swappedBaseline, noFitInput),
      /caller baseline/,
    );
  });

  const invalidInput = verifyInput({
    baseline: manualProofReceipt.baseline,
    marker: markerReceipt(manualProofReceipt.baseline, { serial: "emulator-5556" }),
  });
  const invalid = await execute(invalidInput, selectorDeps({ verifyOnly: true }));

  await t.test("rejects a markerless relational-invalid baseline substitution", async () => {
    const swappedBaseline = structuredClone(invalid);
    swappedBaseline.baseline.bootId = "another-boot";
    assert.equal(selectHomeEnvironmentOutputSchema.safeParse(swappedBaseline).success, true);
    await assert.rejects(
      invokeRegistered(swappedBaseline, invalidInput),
      /caller baseline/,
    );
  });

  await t.test("requires a returned baseline even for relational invalid_request", async () => {
    const missingBaseline = structuredClone(invalid);
    missingBaseline.baseline = null;
    assert.equal(selectHomeEnvironmentOutputSchema.safeParse(missingBaseline).success, true);
    await assert.rejects(
      invokeRegistered(missingBaseline, invalidInput),
      /caller baseline/,
    );
  });
});

test("every real verification failure identifies its causal phase", async (t) => {
  const failures = await realFailurePhaseResults();
  const expectedPhases = {
    pre_world_space: "pre_world_space",
    pre_query: "pre_query",
    marker: "marker",
    host_selection: "host_selection",
    post_world_space: "post_world_space",
    post_query: "post_query",
    classification: "classification",
    verify_post_world_space: "post_world_space",
    verify_post_query: "post_query",
    verify_classification: "classification",
  };

  for (const [name, result] of Object.entries(failures)) {
    await t.test(name, () => {
      assert.equal(result.status, "verification_failed");
      assert.equal(result.failurePhase, expectedPhases[name]);
      assert.equal(selectHomeEnvironmentOutputSchema.safeParse(result).success, true);
    });
  }
});

test("observation failure codes reject every pairwise swap at both real attempt phases", async (t) => {
  const cases = observationFailureCases(await realFailureReceiptCases());
  assert.equal(cases.length, 7);
  for (const { name, code, result } of cases) {
    for (const replacement of Object.values(OBSERVATION_CODE_BY_OUTCOME)) {
      if (replacement === code) continue;
      await t.test(`${name}: ${code} -> ${replacement}`, () => {
        const impossible = structuredClone(result);
        impossible.error.code = replacement;
        assert.equal(
          selectHomeEnvironmentOutputSchema.safeParse(impossible).success,
          false,
          `${name} accepted pairwise observation-code swap ${replacement}`,
        );
      });
    }
  }
});

test("registered handler rejects every pairwise observation-code escape", async (t) => {
  const cases = observationFailureCases(await realFailureReceiptCases());
  for (const { name, code, result } of cases) {
    for (const replacement of Object.values(OBSERVATION_CODE_BY_OUTCOME)) {
      if (replacement === code) continue;
      await t.test(`${name}: ${code} -> ${replacement}`, async () => {
        const impossible = structuredClone(result);
        impossible.error.code = replacement;
        let registration;
        const server = {
          registerTool(toolName, config, handler) {
            registration = { toolName, config, handler };
          },
        };
        registerHomeEnvironmentSelectorTools(server, async () => impossible);
        await assert.rejects(registration.handler({ action: "rank", ...SOURCE }));
      });
    }
  }
});

test("every real observation call records an action-appropriate strict attempt receipt", async (t) => {
  const cases = new Map((await realFailureReceiptCases()).map((entry) => [entry.name, entry.result]));
  const manual = await execute(switchInput(), selectorDeps({ hostResult: hostManual() }));
  const selectedSwitch = await execute(switchInput(), selectorDeps());
  const selectedVerify = await execute(
    verifyInput({ baseline: manual.baseline, marker: manual.verification.marker }),
    selectorDeps({ verifyOnly: true }),
  );
  const exactPreObservation = observation({ observedAtEpochSeconds: 1788064692.863 });
  const exactPostObservation = observation();
  const outputs = [
    ["pre missing", cases.get("pre observation missing"), expectedObservationAttempt("pre_world_space", "missing"), null],
    ["pre invalid", cases.get("pre observation invalid"), expectedObservationAttempt("pre_world_space", "invalid"), null],
    ["pre failed", cases.get("pre observation failed"), expectedObservationAttempt("pre_world_space", "failed"), null],
    ["pre-query failure", cases.get("pre terminal not_ready"), expectedObservationAttempt("pre_world_space", "observed", exactPreObservation), null],
    ["manual switch", manual, expectedObservationAttempt("pre_world_space", "observed", exactPreObservation), null],
    ["post missing", cases.get("post observation missing"), expectedObservationAttempt("pre_world_space", "observed", exactPreObservation), expectedObservationAttempt("post_world_space", "missing")],
    ["post invalid", cases.get("post observation invalid"), expectedObservationAttempt("pre_world_space", "observed", exactPreObservation), expectedObservationAttempt("post_world_space", "invalid")],
    ["post failed", cases.get("post observation failed"), expectedObservationAttempt("pre_world_space", "observed", exactPreObservation), expectedObservationAttempt("post_world_space", "failed")],
    ["post-query failure", cases.get("post snapshot unchanged"), expectedObservationAttempt("pre_world_space", "observed", exactPreObservation), expectedObservationAttempt("post_world_space", "observed", exactPostObservation)],
    ["selected switch", selectedSwitch, expectedObservationAttempt("pre_world_space", "observed", exactPreObservation), expectedObservationAttempt("post_world_space", "observed", exactPostObservation)],
    ["selected verify", selectedVerify, null, expectedObservationAttempt("post_world_space", "observed", exactPostObservation)],
    ["failed verify", cases.get("verify post observation missing"), null, expectedObservationAttempt("post_world_space", "missing")],
  ];

  for (const [name, result, preAttempt, postAttempt] of outputs) {
    await t.test(name, () => {
      assert.ok(result, `${name} fixture`);
      assert.deepEqual(result.verification.preWorldSpaceAttempt, preAttempt);
      assert.deepEqual(result.verification.postWorldSpaceAttempt, postAttempt);
    });
  }
});

test("observation failure codes reject schema-valid attempt-outcome swaps", async (t) => {
  const cases = observationFailureCases(await realFailureReceiptCases());
  for (const { name, phase, code, result } of cases) {
    const key = phase === "pre_world_space" ? "preWorldSpaceAttempt" : "postWorldSpaceAttempt";
    const originalOutcome = Object.entries(OBSERVATION_CODE_BY_OUTCOME)
      .find(([, expectedCode]) => expectedCode === code)?.[0];
    assert.ok(originalOutcome, `${name}: known observation outcome`);
    for (const replacementOutcome of Object.keys(OBSERVATION_CODE_BY_OUTCOME)) {
      if (replacementOutcome === originalOutcome) continue;
      await t.test(`${name}: ${originalOutcome} -> ${replacementOutcome}`, () => {
        assert.ok(result.verification[key], `${name}: attempt receipt exists`);
        const impossible = structuredClone(result);
        impossible.verification[key] = expectedObservationAttempt(phase, replacementOutcome);
        assert.equal(
          selectHomeEnvironmentOutputSchema.safeParse(impossible).success,
          false,
          `${phase}/${code} accepted ${replacementOutcome} attempt outcome`,
        );
      });
    }
  }
});

test("observation attempt schema rejects phase, observation-presence, and diagnostic contradictions", async (t) => {
  const cases = new Map((await realFailureReceiptCases()).map((entry) => [entry.name, entry.result]));
  const selected = await execute(switchInput(), selectorDeps());
  const contradictions = [
    ["observed without observation", selected, "preWorldSpaceAttempt", (attempt) => { delete attempt.observation; }],
    ["observed with diagnostic", selected, "postWorldSpaceAttempt", (attempt) => { attempt.diagnostic = "unexpected"; }],
    ["missing with observation", cases.get("pre observation missing"), "preWorldSpaceAttempt", (attempt) => { attempt.observation = observation(); }],
    ["missing with diagnostic", cases.get("post observation missing"), "postWorldSpaceAttempt", (attempt) => { attempt.diagnostic = "unexpected"; }],
    ["invalid with observation", cases.get("pre observation invalid"), "preWorldSpaceAttempt", (attempt) => { attempt.observation = observation(); }],
    ["invalid without diagnostic", cases.get("post observation invalid"), "postWorldSpaceAttempt", (attempt) => { delete attempt.diagnostic; }],
    ["failed with observation", cases.get("pre observation failed"), "preWorldSpaceAttempt", (attempt) => { attempt.observation = observation(); }],
    ["failed without diagnostic", cases.get("post observation failed"), "postWorldSpaceAttempt", (attempt) => { delete attempt.diagnostic; }],
    ["pre field with post phase", selected, "preWorldSpaceAttempt", (attempt) => { attempt.phase = "post_world_space"; }],
    ["post field with pre phase", selected, "postWorldSpaceAttempt", (attempt) => { attempt.phase = "pre_world_space"; }],
    ["oversized bounded diagnostic", cases.get("pre observation failed"), "preWorldSpaceAttempt", (attempt) => { attempt.diagnostic = "x".repeat(161); }],
  ];

  for (const [name, source, key, mutate] of contradictions) {
    await t.test(name, () => {
      assert.ok(source?.verification[key], `${name}: real attempt receipt exists`);
      const impossible = structuredClone(source);
      mutate(impossible.verification[key]);
      assert.equal(selectHomeEnvironmentOutputSchema.safeParse(impossible).success, false);
    });
  }
});

test("observation failure diagnostics are deterministic, bounded, and redact thrown values", async () => {
  const secret = "credential=do-not-serialize-this-value";
  const result = await execute(
    switchInput(),
    selectorDeps({ observeError: "pre", observeErrorMessage: secret }),
  );

  assert.equal(result.status, "verification_failed");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(
    result.verification.preWorldSpaceAttempt,
    expectedObservationAttempt("pre_world_space", "failed"),
  );
  assert.ok(result.verification.preWorldSpaceAttempt.diagnostic.length <= 160);
});

test("real verification failures retain the runtime and selected-target receipts needed for relational validation", async () => {
  const cases = await realFailureReceiptCases();
  for (const { name, result } of cases) {
    assert.deepEqual(result.verification.runtime, RUNTIME, `${name}: runtime receipt`);
    assert.deepEqual(result.verification.target, {
      tile: "Livingroom Day",
      sceneId: "XiataAncientPath",
      selectedDialogSha256: TARGET_DIALOG_SHA256,
    }, `${name}: target receipt`);
  }
});

test("failure receipt matrix rejects every error code when its observable receipt no longer exhibits that failure", async (t) => {
  const cases = await realFailureReceiptCases();
  for (const { name, phase, code, result, nonExhibiting } of cases) {
    await t.test(name, () => {
      assert.equal(result.status, "verification_failed");
      assert.equal(result.failurePhase, phase);
      assert.equal(result.error.code, code);
      const impossible = structuredClone(result);
      nonExhibiting(impossible);
      assert.equal(
        selectHomeEnvironmentOutputSchema.safeParse(impossible).success,
        false,
        `${phase}/${code} accepted a receipt that does not exhibit the named failure`,
      );
    });
  }
});

test("phase prerequisite matrix rejects contradictory receipt contents", async (t) => {
  const cases = await realFailureReceiptCases();
  const byName = new Map(cases.map((entry) => [entry.name, entry.result]));
  const exactRuntime = () => structuredClone(RUNTIME);
  const exactTarget = () => ({
    tile: "Livingroom Day",
    sceneId: "XiataAncientPath",
    selectedDialogSha256: TARGET_DIALOG_SHA256,
  });
  const mutations = [
    ["marker runtime serial must bind its baseline", "marker command failed", (result) => {
      result.verification.runtime ??= exactRuntime();
      result.verification.target ??= exactTarget();
      result.verification.runtime.serial = "emulator-5556";
    }],
    ["marker target scene must bind the observed context", "marker command failed", (result) => {
      result.verification.runtime ??= exactRuntime();
      result.verification.target ??= exactTarget();
      result.verification.target.sceneId = "AnotherCoarseScene";
    }],
    ["marker baseline dataset must bind the dataset receipt", "marker command failed", (result) => {
      result.baseline.datasetId = "another-dataset";
    }],
    ["marker baseline serial must bind runtime", "marker command failed", (result) => {
      result.baseline.serial = "emulator-5556";
    }],
    ["marker baseline package must bind runtime", "marker command failed", (result) => {
      result.baseline.packageName = "com.example.other";
    }],
    ["marker baseline build receipt must bind runtime", "marker command failed", (result) => {
      result.baseline.expectedBuildReceiptId = "a".repeat(64);
    }],
    ["marker baseline boot must bind the ready pre-query", "marker command failed", (result) => {
      result.baseline.bootId = "another-boot-id";
    }],
    ["marker baseline snapshot must bind the ready pre-query", "marker command failed", (result) => {
      result.baseline.snapshotId = "a".repeat(64);
      result.verification.preSnapshotId = "a".repeat(64);
    }],
    ["marker pre WorldSpace scene must match the selected target", "marker command failed", (result) => {
      result.verification.preWorldSpaceAttempt.observation.sceneId = "AnotherCoarseScene";
    }],
    ["marker pre-query serial identity must match runtime", "marker command failed", (result) => {
      result.verification.preQuery.applicationRuntimeBinding.serial = "emulator-5556";
      result.verification.preQuery.applicationRuntimeBinding.liveIdentity.serial = "emulator-5556";
    }],
    ["marker pre-query package identity must match runtime", "marker command failed", (result) => {
      const binding = result.verification.preQuery.applicationRuntimeBinding;
      binding.packageName = "com.example.other";
      binding.foregroundProcess.packageName = "com.example.other";
      binding.foregroundProcess.component = "com.example.other/.MainActivity";
    }],
    ["marker pre-query build receipt must match runtime", "marker command failed", (result) => {
      result.verification.preQuery.applicationRuntimeBinding.buildReceiptId = "a".repeat(64);
    }],
    ["marker pre-query boot must match baseline", "marker command failed", (result) => {
      result.verification.preQuery.applicationRuntimeBinding.liveIdentity.bootId = "another-boot-id";
    }],
    ["marker pre-query stage must match runtime", "marker command failed", (result) => {
      const binding = result.verification.preQuery.applicationRuntimeBinding;
      binding.requestedStageStyle = "Full";
      binding.observedStageStyle = "Full";
    }],
    ["marker pre-query root must remain stage", "marker command failed", (result) => {
      result.verification.preQuery.applicationRuntimeBinding.rootContainer = "unbound-root";
    }],
    ["marker pre-query configured drift policy must match", "marker command failed", (result) => {
      result.verification.preQuery.applicationRuntimeBinding.effectiveSceneDriftPolicy.maxExtentDeltaM = 0.02;
    }],
    ["marker pre-query echoed drift policy must match", "marker command failed", (result) => {
      result.verification.preQuery.drift.effectivePolicy.count = "strict";
    }],
    ["marker pre-query drift must be within policy", "marker command failed", (result) => {
      result.verification.preQuery.drift.withinPolicy = false;
    }],
    ["host failure marker serial must bind runtime", "host selection not observed", (result) => {
      result.verification.marker.serial = "emulator-5556";
    }],
    ["host failure marker nonce must bind baseline snapshot", "host selection not observed", (result) => {
      result.verification.marker.nonce = "a".repeat(64);
      result.verification.marker.message = `MARK ${"a".repeat(64)}`;
    }],
    ["host failure marker message must bind baseline snapshot", "host selection not observed", (result) => {
      result.verification.marker.message = "MARK another-snapshot";
    }],
    ["post WorldSpace requires the exact selected-dialog hash receipt", "post observation missing", (result) => {
      result.hostSelection.afterDialogSha256 = "a".repeat(64);
    }],
    ["post query requires a matching WorldSpace scene", "post snapshot unchanged", (result) => {
      result.verification.postWorldSpaceAttempt.observation.sceneId = "AnotherCoarseScene";
    }],
    ["classification requires post-query serial identity", "wrong unique environment", (result) => {
      result.verification.postQuery.applicationRuntimeBinding.serial = "emulator-5556";
      result.verification.postQuery.applicationRuntimeBinding.liveIdentity.serial = "emulator-5556";
    }],
    ["classification requires post-query drift policy", "wrong unique environment", (result) => {
      result.verification.postQuery.drift.effectivePolicy.topology = "advisory";
    }],
    ["classification requires post-query drift within policy", "wrong unique environment", (result) => {
      result.verification.postQuery.drift.withinPolicy = false;
    }],
    ["verify baseline serial must bind runtime", "verify post snapshot unchanged", (result) => {
      result.baseline.serial = "emulator-5556";
    }],
  ];

  for (const [name, sourceName, mutate] of mutations) {
    await t.test(name, () => {
      const source = byName.get(sourceName);
      assert.ok(source, sourceName);
      const impossible = structuredClone(source);
      mutate(impossible);
      assert.equal(selectHomeEnvironmentOutputSchema.safeParse(impossible).success, false);
    });
  }
});

test("registered handler rejects contradictory failure receipts before structuredContent escapes", async (t) => {
  const cases = await realFailureReceiptCases();
  const byName = new Map(cases.map((entry) => [entry.name, entry]));
  const contradictions = [
    ["marker serial is not receipt-bound", "host selection not observed", (result) => {
      result.verification.marker.serial = "emulator-5556";
    }],
    ["identity error has an identity-correct ready query", "pre identity serial", (result) => {
      Object.assign(result, replaceFailureQuery(result, "pre", bedroomDayQuery));
    }],
    ["not-observed error carries a manual host result", "host selection not observed", (result) => {
      result.hostSelection = hostManual();
    }],
  ];

  for (const [name, sourceName, mutate] of contradictions) {
    await t.test(name, async () => {
      const source = byName.get(sourceName);
      assert.ok(source, sourceName);
      const impossible = structuredClone(source.result);
      mutate(impossible);
      let registration;
      const server = {
        registerTool(toolName, config, handler) {
          registration = { toolName, config, handler };
        },
      };
      registerHomeEnvironmentSelectorTools(server, async () => impossible);
      await assert.rejects(registration.handler({ action: "rank", ...SOURCE }));
    });
  }
});

test("failure phases reject missing prerequisites and downstream receipts", async (t) => {
  const failures = await realFailurePhaseResults();
  const selected = await execute(switchInput(), selectorDeps());
  const proof = await manualProof();
  const verifySelected = await execute(verifyInput(proof), selectorDeps({ verifyOnly: true }));
  const mutations = [
    ["pre WorldSpace cannot carry a post observation", {
      ...structuredClone(failures.pre_world_space),
      verification: {
        ...structuredClone(failures.pre_world_space.verification),
        postWorldSpaceAttempt: structuredClone(selected.verification.postWorldSpaceAttempt),
      },
    }],
    ["pre query cannot carry a baseline", {
      ...structuredClone(failures.pre_query),
      baseline: structuredClone(selected.baseline),
    }],
    ["marker cannot lose its baseline prerequisite", {
      ...structuredClone(failures.marker),
      baseline: null,
    }],
    ["marker cannot carry a downstream host receipt", {
      ...structuredClone(failures.marker),
      hostSelection: structuredClone(selected.hostSelection),
    }],
    ["host selection cannot lose its marker prerequisite", {
      ...structuredClone(failures.host_selection),
      verification: {
        ...structuredClone(failures.host_selection.verification),
        marker: null,
      },
    }],
    ["post WorldSpace cannot carry post-query success evidence", {
      ...structuredClone(failures.post_world_space),
      verification: {
        ...structuredClone(failures.post_world_space.verification),
        postQuery: structuredClone(selected.verification.postQuery),
        postSnapshotId: selected.verification.postSnapshotId,
        classification: structuredClone(selected.verification.classification),
      },
    }],
    ["post query cannot carry a downstream successful classification", {
      ...structuredClone(failures.post_query),
      verification: {
        ...structuredClone(failures.post_query.verification),
        classification: structuredClone(selected.verification.classification),
      },
    }],
    ["classification cannot lose its post-WorldSpace prerequisite", {
      ...structuredClone(failures.classification),
      verification: {
        ...structuredClone(failures.classification.verification),
        postWorldSpaceAttempt: null,
      },
    }],
    ["verify post WorldSpace cannot carry post-query success evidence", {
      ...structuredClone(failures.verify_post_world_space),
      verification: {
        ...structuredClone(failures.verify_post_world_space.verification),
        postQuery: structuredClone(verifySelected.verification.postQuery),
        postSnapshotId: verifySelected.verification.postSnapshotId,
        classification: structuredClone(verifySelected.verification.classification),
      },
    }],
    ["verify post query cannot carry a downstream successful classification", {
      ...structuredClone(failures.verify_post_query),
      verification: {
        ...structuredClone(failures.verify_post_query.verification),
        classification: structuredClone(verifySelected.verification.classification),
      },
    }],
    ["verify classification cannot lose its post-WorldSpace prerequisite", {
      ...structuredClone(failures.verify_classification),
      verification: {
        ...structuredClone(failures.verify_classification.verification),
        postWorldSpaceAttempt: null,
      },
    }],
  ];

  for (const [name, result] of mutations) {
    await t.test(name, () => {
      assert.equal(selectHomeEnvironmentOutputSchema.safeParse(result).success, false);
    });
  }
});

test("registered handler blocks near-success failures with a missing prerequisite", async (t) => {
  const failures = await realFailurePhaseResults();
  const selected = await execute(switchInput(), selectorDeps());
  const withoutBaseline = useFailureIdentity(selected, failures.post_world_space);
  withoutBaseline.baseline = null;
  const withoutPostWorldSpace = useFailureIdentity(selected, failures.classification);
  withoutPostWorldSpace.verification.postWorldSpaceAttempt = null;

  for (const [name, impossible] of [
    ["baseline", withoutBaseline],
    ["post WorldSpace", withoutPostWorldSpace],
  ]) {
    await t.test(name, async () => {
      let registration;
      const server = {
        registerTool(toolName, config, handler) {
          registration = { toolName, config, handler };
        },
      };
      registerHomeEnvironmentSelectorTools(server, async () => impossible);
      await assert.rejects(registration.handler({ action: "rank", ...SOURCE }));
    });
  }
});

test("verify accepts only the matching returned baseline and performs no host action", async (t) => {
  const proof = await manualProof();
  for (const [name, changed] of [
    ["dataset", { datasetId: "another-dataset" }],
    ["serial", { serial: "emulator-5556" }],
    ["package", { packageName: "com.example.other" }],
    ["receipt", { expectedBuildReceiptId: "a".repeat(64) }],
  ]) {
    await t.test(`rejects ${name} mismatch`, async () => {
      const deps = selectorDeps({ verifyOnly: true });
      const result = await execute(verifyInput({
        baseline: { ...proof.baseline, ...changed },
        marker: proof.marker,
      }), deps);
      assert.equal(result.status, "invalid_request");
      assert.equal(result.error.code, "baseline_mismatch");
      assert.deepEqual(deps.calls, []);
    });
  }

  await t.test("uses current evidence rather than inferring success from the earlier tile click", async () => {
    const deps = selectorDeps({ verifyOnly: true });
    const result = await execute(verifyInput(proof), deps);
    assert.equal(result.status, "selected_verified");
    assert.equal(result.hostSelection, null);
    assert.deepEqual(deps.calls, ["observe-post", "query-post"]);
    assert.equal(result.verification.preQuery, null);
    assert.equal(result.verification.postQuery.snapshotId, livingroomDayQuery.snapshotId);
  });
});

test("missing or failed WorldSpace observation and marker operations fail closed", async (t) => {
  for (const [name, options, expectedCalls, code] of [
    ["missing pre observation", { preObservation: null }, ["observe-pre"], "world_space_observation_missing"],
    ["failed pre observation", { observeError: "pre" }, ["observe-pre"], "world_space_observation_failed"],
    ["invalid pre observation", { preObservation: { ...observation(), unexpected: true } }, ["observe-pre"], "world_space_observation_invalid"],
    ["failed marker", { markError: "exact serial marker failed" }, ["observe-pre", "query-pre", "mark"], "world_space_marker_failed"],
    ["missing post observation", { postObservation: null }, ["observe-pre", "query-pre", "mark", "host-select", "observe-post"], "world_space_observation_missing"],
    ["failed post observation", { observeError: "post" }, ["observe-pre", "query-pre", "mark", "host-select", "observe-post"], "world_space_observation_failed"],
    ["invalid post observation", { postObservation: { ...observation(), unexpected: true } }, ["observe-pre", "query-pre", "mark", "host-select", "observe-post"], "world_space_observation_invalid"],
  ]) {
    await t.test(name, async () => {
      const deps = selectorDeps(options);
      const result = await execute(switchInput(), deps);
      assert.equal(result.status, "verification_failed");
      assert.equal(result.error.code, code);
      assert.deepEqual(deps.calls, expectedCalls);
    });
  }
});

test("manual verify carries a durable marker through a rotated log and changed mesh classification", async () => {
  const baseline = baselineReceipt();
  const marker = markerReceipt(baseline);
  const deps = selectorDeps({ verifyOnly: true });
  const liveObservation = defaultHomeEnvironmentSelectorDependencies().observeCurrentDefaultSpace;
  deps.observeCurrentDefaultSpace = async (serial, boundary) => {
    deps.calls.push("observe-post");
    assert.equal(serial, SERIAL);
    assert.deepEqual(boundary, marker);
    return liveObservation(serial, boundary);
  };

  const result = await withFakeAdb([`${WORLDSPACE_LINE}\n`], async () => (
    execute(verifyInput({ baseline, marker }), deps)
  ));

  assert.equal(result.status, "selected_verified");
  assert.equal(result.hostSelection, null);
  assert.deepEqual(result.verification.marker, marker);
  assert.equal(result.verification.preWorldSpaceAttempt, null);
  assert.equal(result.verification.preQuery, null);
  assert.equal(result.verification.postQuery.snapshotId, livingroomDayQuery.snapshotId);
  assert.deepEqual(deps.calls, ["observe-post", "query-post"]);
  assert.deepEqual(deps.hostInputs, []);
});

test("verify requires a producer-consistent marker and rejects every identity or raw-row contradiction", async (t) => {
  const baseline = baselineReceipt();

  await t.test("missing marker", async () => {
    const deps = selectorDeps({ verifyOnly: true });
    const result = await execute(verifyInput({ baseline, marker: undefined }), deps);
    assert.equal(result.status, "invalid_request");
    assert.deepEqual(deps.calls, []);
  });

  const anotherNonce = "a".repeat(64);
  const contradictions = [
    ["serial", markerReceipt(baseline, { serial: "emulator-5556" })],
    ["nonce", markerReceipt(baseline, { nonce: anotherNonce })],
    ["message", markerReceipt(baseline, { message: `MARK ${anotherNonce}` })],
    ["tag", markerReceipt(baseline, { tag: "AnotherSelector" })],
    ["epoch", markerReceipt(baseline, {
      observedAtEpochSeconds: MARKER_EPOCH + 1,
      rawLine: markerRawLine(baseline.snapshotId),
    })],
    ["raw line", markerReceipt(baseline, {
      rawLine: markerRawLine(baseline.snapshotId, { message: `MARK ${anotherNonce}` }),
    })],
    ["non-exact raw line", markerReceipt(baseline, {
      rawLine: `${markerRawLine(baseline.snapshotId)}\r`,
    })],
    ["malformed raw line", markerReceipt(baseline, { rawLine: `noise ${markerRawLine(baseline.snapshotId)}` })],
  ];
  for (const [name, marker] of contradictions) {
    await t.test(name, async () => {
      const deps = selectorDeps({ verifyOnly: true });
      const result = await execute(verifyInput({ baseline, marker }), deps);
      assert.equal(result.status, "invalid_request");
      assert.deepEqual(deps.calls, []);
    });
  }
});

test("verify rejects a WorldSpace observation at the durable marker boundary", async () => {
  const baseline = baselineReceipt();
  const marker = markerReceipt(baseline);
  const deps = selectorDeps({ verifyOnly: true });
  deps.observeCurrentDefaultSpace = async (serial, boundary) => {
    deps.calls.push("observe-post");
    assert.equal(serial, SERIAL);
    assert.deepEqual(boundary, marker);
    return observation({
      observedAtEpochSeconds: marker.observedAtEpochSeconds,
      rawLine: WORLDSPACE_LINE.replace("1788064752.864", String(marker.observedAtEpochSeconds)),
    });
  };

  const result = await execute(verifyInput({ baseline, marker }), deps);

  assert.equal(result.status, "verification_failed");
  assert.equal(result.failurePhase, "post_world_space");
  assert.equal(result.error.code, "world_space_observation_missing");
  assert.deepEqual(result.verification.marker, marker);
  assert.deepEqual(deps.calls, ["observe-post"]);
  assert.deepEqual(deps.hostInputs, []);
});

test("verify rejects a forged post-WorldSpace epoch that contradicts its exact raw row", async () => {
  const baseline = baselineReceipt();
  const marker = markerReceipt(baseline);
  const deps = selectorDeps({ verifyOnly: true });
  deps.observeCurrentDefaultSpace = async () => {
    deps.calls.push("observe-post");
    return observation({
      observedAtEpochSeconds: marker.observedAtEpochSeconds + 1,
      rawLine: WORLDSPACE_LINE.replace("1788064752.864", String(marker.observedAtEpochSeconds)),
    });
  };

  const result = await execute(verifyInput({ baseline, marker }), deps);

  assert.equal(result.status, "verification_failed");
  assert.equal(result.failurePhase, "post_world_space");
  assert.equal(result.error.code, "world_space_observation_invalid");
  assert.deepEqual(deps.calls, ["observe-post"]);
});

test("marker receipt must bind the exact serial and pre-switch snapshot before host work", async (t) => {
  for (const [name, markerOverrides, errorCode] of [
    ["serial", { serial: "emulator-5556" }, "world_space_marker_mismatch"],
    ["nonce", { nonce: "a".repeat(64), message: `MARK ${"a".repeat(64)}` }, "world_space_marker_mismatch"],
    ["message", { message: "MARK another-snapshot" }, "world_space_marker_failed"],
  ]) {
    await t.test(name, async () => {
      const deps = selectorDeps({ markerOverrides });
      const result = await execute(switchInput(), deps);
      assert.equal(result.status, "verification_failed");
      assert.equal(result.error.code, errorCode);
      assert.deepEqual(deps.calls, ["observe-pre", "query-pre", "mark"]);
    });
  }
});

test("every terminal bridge status fails before later switch or classification work", async (t) => {
  for (const status of [
    "label_absent",
    "not_ready",
    "stage_not_open",
    "bridge_unavailable",
    "stage_mismatch",
    "invalid_payload",
    "binding_failed",
  ]) {
    await t.test(`pre ${status}`, async () => {
      const deps = selectorDeps({ preQuery: terminalQuery(status) });
      const result = await execute(switchInput(), deps);
      assert.equal(result.status, "verification_failed");
      assert.equal(result.error.code, `bridge_${status}`);
      assert.deepEqual(deps.calls, ["observe-pre", "query-pre"]);
    });
    await t.test(`post ${status}`, async () => {
      const deps = selectorDeps({ postQuery: terminalQuery(status) });
      const result = await execute(switchInput(), deps);
      assert.equal(result.status, "verification_failed");
      assert.equal(result.error.code, `bridge_${status}`);
      assert.deepEqual(deps.calls, ["observe-pre", "query-pre", "mark", "host-select", "observe-post", "query-post"]);
      assert.equal(result.verification.classification, null);
    });
  }
});

test("serial, package, receipt, boot, stage, and root identity drift fail at their live boundary", async (t) => {
  const mutations = [
    ["serial", (query) => {
      query.applicationRuntimeBinding.serial = "emulator-5556";
      query.applicationRuntimeBinding.liveIdentity.serial = "emulator-5556";
    }],
    ["package", (query) => {
      query.applicationRuntimeBinding.packageName = "com.example.other";
      query.applicationRuntimeBinding.foregroundProcess.packageName = "com.example.other";
      query.applicationRuntimeBinding.foregroundProcess.component = "com.example.other/.MainActivity";
    }],
    ["receipt", (query) => { query.applicationRuntimeBinding.buildReceiptId = "a".repeat(64); }],
    ["boot", (query) => { query.applicationRuntimeBinding.liveIdentity.bootId = "another-boot-id"; }],
    ["stage", (query) => {
      query.applicationRuntimeBinding.requestedStageStyle = "Full";
      query.applicationRuntimeBinding.observedStageStyle = "Full";
    }],
    ["root", (query) => { query.applicationRuntimeBinding.rootContainer = "unbound-root"; }],
  ];
  for (const [identity, mutate] of mutations) {
    if (identity !== "boot") await t.test(`pre ${identity}`, async () => {
      const preQuery = mutateReady(bedroomDayQuery, mutate);
      const deps = selectorDeps({ preQuery });
      const result = await execute(switchInput(), deps);
      assert.equal(result.status, "verification_failed");
      assert.equal(result.error.code, `identity_drift_${identity}`);
      assert.equal(result.baseline, null);
      assert.deepEqual(deps.calls, ["observe-pre", "query-pre"]);
    });
    await t.test(`post ${identity}`, async () => {
      const postQuery = mutateReady(livingroomDayQuery, mutate);
      const deps = selectorDeps({ postQuery });
      const result = await execute(switchInput(), deps);
      assert.equal(result.status, "verification_failed");
      assert.equal(result.error.code, `identity_drift_${identity}`);
      assert.equal(result.verification.classification, null);
    });
  }
});

test("selector drift limits and complete policy echoes are mandatory at both live boundaries", async (t) => {
  const violations = [
    ["numeric drift", "scene_drift_out_of_policy", (query) => {
      query.drift.withinPolicy = false;
      query.drift.maxTransformDeltaM = 0.02;
      const delta = query.drift.deltas.find((entry) => entry.metric === "anchor");
      delta.transformDeltaM = 0.02;
      delta.withinPolicy = false;
    }],
    ["strict topology", "scene_drift_out_of_policy", (query) => {
      query.drift.withinPolicy = false;
      query.drift.topologyChanges = 1;
      const delta = query.drift.deltas.find((entry) => entry.metric === "anchor");
      delta.topologyChanged = true;
      delta.withinPolicy = false;
    }],
    ["drift policy echo", "scene_drift_policy_mismatch", (query) => {
      query.drift.effectivePolicy.count = "strict";
    }],
    ["binding policy echo", "scene_drift_policy_mismatch", (query) => {
      query.applicationRuntimeBinding.effectiveSceneDriftPolicy.maxExtentDeltaM = 0.02;
    }],
  ];

  for (const [name, errorCode, mutate] of violations) {
    await t.test(`pre ${name}`, async () => {
      const preQuery = mutateReady(bedroomDayQuery, mutate);
      const deps = selectorDeps({ preQuery });
      const result = await execute(switchInput(), deps);
      assert.equal(result.status, "verification_failed");
      assert.equal(result.error.code, errorCode);
      assert.equal(result.baseline, null);
      assert.deepEqual(deps.calls, ["observe-pre", "query-pre"]);
    });

    await t.test(`post ${name}`, async () => {
      const postQuery = mutateReady(livingroomDayQuery, mutate);
      const deps = selectorDeps({ postQuery });
      const result = await execute(switchInput(), deps);
      assert.equal(result.status, "verification_failed");
      assert.equal(result.error.code, errorCode);
      assert.equal(result.verification.classification, null);
      assert.deepEqual(deps.calls, ["observe-pre", "query-pre", "mark", "host-select", "observe-post", "query-post"]);
    });
  }
});

test("coarse scene ID is consistency-only and never disambiguates a changed context", async (t) => {
  await t.test("pre-switch mismatch stops before marker or host work", async () => {
    const deps = selectorDeps({ preObservation: observation({ sceneId: "AnotherCoarseScene" }) });
    const result = await execute(switchInput(), deps);

    assert.equal(result.status, "verification_failed");
    assert.equal(result.error.code, "coarse_scene_mismatch");
    assert.equal(result.verification.sceneIdentityRole, "coarse_consistency_only_non_discriminating");
    assert.deepEqual(deps.calls, ["observe-pre", "query-pre"]);
  });

  await t.test("post-switch mismatch stops before mesh classification", async () => {
    const deps = selectorDeps({ postObservation: observation({ sceneId: "AnotherCoarseScene" }) });
    const result = await execute(switchInput(), deps);

    assert.equal(result.status, "verification_failed");
    assert.equal(result.error.code, "coarse_scene_mismatch");
    assert.equal(result.verification.sceneIdentityRole, "coarse_consistency_only_non_discriminating");
    assert.deepEqual(deps.calls, ["observe-pre", "query-pre", "mark", "host-select", "observe-post"]);
  });
});

test("an unchanged receipt-bound snapshot fails before the clicked target can be inferred", async () => {
  const deps = selectorDeps({ postQuery: bedroomDayQuery });
  const result = await execute(switchInput(), deps);

  assert.equal(result.status, "verification_failed");
  assert.equal(result.error.code, "snapshot_unchanged");
  assert.equal(result.verification.classification, null);
});

test("zero, multiple, extent-mismatched, and wrong unique fingerprints fail closed", async (t) => {
  await t.test("zero matches", async () => {
    const postQuery = mutateReady(livingroomDayQuery, (query) => { query.histogram.SYNTHETIC = 1; });
    const result = await execute(switchInput(), selectorDeps({ postQuery }));
    assert.equal(result.status, "verification_failed");
    assert.equal(result.error.code, "classification_no_match");
    assert.equal(result.verification.classification.status, "no_match");
  });

  await t.test("multiple matches", async () => {
    const dataset = structuredClone(loadPackagedHomeEnvironmentDataset());
    const livingroom = dataset.environments.find((entry) => entry.tile === "Livingroom Day");
    const bedroom = dataset.environments.find((entry) => entry.tile === "Bedroom Day");
    bedroom.totalAnchorCountRange = [...livingroom.totalAnchorCountRange];
    bedroom.histogramRanges = structuredClone(livingroom.histogramRanges);
    const result = await execute(switchInput(), selectorDeps({ dataset }));
    assert.equal(result.status, "verification_failed");
    assert.equal(result.error.code, "classification_ambiguous");
    assert.deepEqual(result.verification.classification.histogramMatches, ["Bedroom Day", "Livingroom Day"]);
  });

  await t.test("incomplete requested-label receipt stops before classification", async () => {
    const postQuery = mutateReady(livingroomDayQuery, (query) => {
      query.requestedLabels = ["FLOOR", "WALL_ART"];
    });
    const result = await execute(switchInput(), selectorDeps({ postQuery }));
    assert.equal(result.status, "verification_failed");
    assert.equal(result.failurePhase, "post_query");
    assert.equal(result.error.code, "bridge_result_invalid");
    assert.equal(result.verification.classification, null);
  });

  await t.test("extent mismatch after one histogram match", async () => {
    const postQuery = mutateReady(livingroomDayQuery, (query) => {
      for (const anchor of query.anchors) {
        if (anchor.labels.includes("TABLE")) anchor.boundsM = [99, anchor.boundsM[1], 99];
      }
    });
    const result = await execute(switchInput(), selectorDeps({ postQuery }));
    assert.equal(result.status, "verification_failed");
    assert.equal(result.error.code, "classification_extent_mismatch");
    assert.equal(result.verification.classification.predicates.surfaceExtentMultisetsMatch, false);
    assert.equal(result.verification.classification.predicates.requirementsFit, null);
  });

  await t.test("cluster cardinality mismatch after one histogram match", async () => {
    const postQuery = mutateReady(livingroomDayQuery, (query) => {
      const source = query.anchors.find((anchor) => anchor.labels.includes("TABLE") && anchor.boundsM[0] > 0.7);
      const duplicate = structuredClone(source);
      duplicate.traceId = "anchor-9999";
      duplicate.runtimeUuid = `${source.runtimeUuid}-duplicate`;
      query.anchors.push(duplicate);
      query.matchedAnchorCount = query.anchors.length;
    });
    const result = await execute(switchInput(), selectorDeps({ postQuery }));
    assert.equal(result.status, "verification_failed");
    assert.equal(result.failurePhase, "classification");
    assert.equal(result.error.code, "classification_extent_mismatch");
    assert.equal(result.verification.classification.predicates.surfaceExtentMultisetsMatch, false);
    assert.equal(result.verification.classification.predicates.requirementsFit, null);
  });

  await t.test("cluster Y mismatch after one histogram match", async () => {
    const postQuery = mutateReady(livingroomDayQuery, (query) => {
      query.anchors.find((anchor) => anchor.labels.includes("TABLE") && anchor.boundsM[0] > 0.7).boundsM[1] += 0.02;
    });
    const result = await execute(switchInput(), selectorDeps({ postQuery }));
    assert.equal(result.status, "verification_failed");
    assert.equal(result.failurePhase, "classification");
    assert.equal(result.error.code, "classification_extent_mismatch");
    assert.equal(result.verification.classification.predicates.surfaceExtentMultisetsMatch, false);
    assert.equal(result.verification.classification.predicates.requirementsFit, null);
  });

  await t.test("wrong unique environment", async () => {
    const result = await execute(switchInput(), selectorDeps({ postQuery: livingroomNightQuery }));
    assert.equal(result.status, "verification_failed");
    assert.equal(result.error.code, "wrong_unique_environment");
    assert.equal(result.verification.classification.environment.tile, "Livingroom Night");
    assert.equal(result.selectedTarget, "Livingroom Day");
  });
});

test("select_home_environment is registered only on the full surface", async () => {
  const fullTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "index.js")],
    env: { ...process.env, PICO_MCP_SURFACE: "full" },
  });
  const doorsTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "index.js")],
    env: { ...process.env, PICO_MCP_SURFACE: "doors" },
  });
  const fullClient = new Client({ name: "home-environment-selector-full-test", version: "0.0.0" });
  const doorsClient = new Client({ name: "home-environment-selector-doors-test", version: "0.0.0" });

  try {
    await fullClient.connect(fullTransport);
    await doorsClient.connect(doorsTransport);
    const fullNames = (await fullClient.listTools()).tools.map((tool) => tool.name);
    const doorsNames = (await doorsClient.listTools()).tools.map((tool) => tool.name);

    assert.ok(fullNames.includes("select_home_environment"));
    assert.equal(doorsNames.includes("select_home_environment"), false);
  } finally {
    await fullClient.close();
    await doorsClient.close();
  }
});
