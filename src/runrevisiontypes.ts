import crypto from "node:crypto";
import path from "node:path";
import { appSpecSchema, isSafeIblAssetPath, type AppSpec } from "./appspec.js";
import { canonicalJson } from "./runreceiptidentity.js";

export const RUN_REVISION_MAX = 256;
export const RUN_REVISION_MAX_BYTES = 512 * 1024;
export const RUN_ACCEPTANCE_MAX = 64;
export const RUN_ACCEPTANCE_MAX_BYTES = 256 * 1024;

const STRING_MAX_BYTES = 64 * 1024;
const ORIGINAL_GOAL_MAX_BYTES = 256 * 1024;
const DIAGNOSTIC_MAX_BYTES = 4 * 1024;
const JSON_MAX_DEPTH = 32;
const JSON_MAX_ARRAY = 4_096;
const JSON_MAX_KEYS = 1_024;
const PUBLIC_RESULT_MAX_BYTES = 4 * 1024 * 1024;
const APP_SPEC_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const EXTERNAL_INPUT_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const BRIEF_PAYLOAD_SNAPSHOT_MAX_BYTES = 3 * 1024 * 1024;
const COMPILER_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
const COMPILER_LEDGER_MAX_STEPS = 4_096;
const COMPILER_LEDGER_MAX_WRITES = 20_000;
const EXTERNAL_INPUT_MAX_ENTRIES = 256;
const EXTERNAL_PATH_MAX_BYTES = 16 * 1024;
const EXTERNAL_INPUT_TOTAL_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const LOCATOR_MAX_COMPONENTS = 64;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_V4_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export type Sha256 = string;
export type LowercaseUuidV4 = string;
export type CanonicalUtcTimestamp = string;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RunWorkflowV1 = "pico-build-app" | "pico-loop";

export type StrictAcceptanceCriterionV1 =
  | { kind: "structural"; inputIndex: number; criterionDigest: Sha256;
      entitiesPresent: string[]; minEntities: number | null;
      componentsPresent: string[] }
  | { kind: "visual"; inputIndex: number; criterionDigest: Sha256 }
  | { kind: "logcat"; inputIndex: number; criterionDigest: Sha256;
      pattern: string; tag: string | null; timeoutSec: number }
  | { kind: "perf"; inputIndex: number; criterionDigest: Sha256;
      minAppFpsP5: number; durationSec: number };
type WithoutCriterionDigest<T> = T extends unknown ? Omit<T, "criterionDigest"> : never;
type StrictAcceptanceCriterionPayloadV1 = WithoutCriterionDigest<StrictAcceptanceCriterionV1>;

export type SnapshotRefV1 = {
  kind: "goal" | "acceptance" | "app-spec" | "brief-payload" |
    "external-input" | "compiler-ledger" | "public-result";
  algorithm: "sha256";
  sha256: Sha256;
  bytes: number;
};

export type PublicWorkflowStatusV1 =
  | "needs-authoring" | "plan-failed" | "failed" | "built-not-installed"
  | "built-no-capture" | "auto-judged-needs-look" | "built-needs-look"
  | "accepted" | "unmeasurable-acceptance" | "no-progress"
  | "manual-repair-required" | "budget-exhausted";

export type GoalSnapshotV1 = { kind: "pico.workflow-goal"; schemaVersion: 1; goal: string };
export type AcceptanceSnapshotV1 = { kind: "pico.workflow-acceptance"; schemaVersion: 1; criteria: StrictAcceptanceCriterionV1[] };
export type AppSpecSnapshotV1 = { kind: "pico.workflow-app-spec"; schemaVersion: 1; spec: AppSpec };
export type BriefPayloadSnapshotV1 = { kind: "pico.workflow-brief-payload"; schemaVersion: 1; id: string; brief: string; spec: AppSpec };

export type ExternalInputSnapshotV1 = {
  kind: "pico.workflow-external-input";
  schemaVersion: 1;
  policy: "pico-fleet-external-input-v1";
  appSpecSha256: Sha256;
  briefPayloadSha256: Sha256;
  resourceKey: Sha256;
  projectResourceKey: Sha256;
  physicalProjectDir: string;
  inputBaseDir: string;
  iblSelector: null | {
    userIblDir: string;
    corpusBriefsDir: string;
    selected: "user" | "corpus";
    selectedPhysicalDir: string;
    reason: "safe-user-ibl-directory-present" | "user-ibl-directory-absent";
  };
  uses: Array<{
    order: number;
    jsonPointer: string;
    role: "semantic-scene" | "occupancy-grid" |
      "environment-model" | "environment-splat" | "environment-pano" |
      "seat-model" | "model-sidecar" | "ibl-source" | "ibl-project-fallback";
    declaredPath: string;
    resolvedPath: string;
    fileIndex: number | null;
  }>;
  files: Array<
    | { status: "absent"; resolvedPath: string }
    | { status: "observed"; resolvedPath: string; realPath: string;
        bytes: number; sha256: Sha256;
        validation: "semantic-json" | "occupancy-json" |
          "self-contained-model" | "model-sidecar" |
          "splat" | "pano" | "ibl-ktx" | "invalid" }
  >;
  iblChoices: Array<{
    ktxAssetPath: string;
    resolution: "external-source" | "project-generation" | "unresolved";
    externalFileIndex: number | null;
  }>;
  uniqueFileCount: number;
  totalBytes: number;
};

export type CompilerStepExecutionV1 = {
  disposition: "scaffolded" | "reused-project" | "executed-success" |
    "native-stage-success" | "executed-failed" | "native-stage-failed" |
    "not-attempted" | "in-doubt";
  outputConfirmation: "confirmed" | "unconfirmed" | "not-applicable";
  detailDigest: Sha256 | null;
};

export type ProjectWriteRecordV1 = {
  path: string;
  origin: "scaffold" | "compiler-step" | "asset-delivery" | "fleet-runtime";
  stepOrder: number | null;
  before: null | { bytes: number; sha256: Sha256 };
  after: null | { bytes: number; sha256: Sha256 };
};

export type CompilerLedgerSnapshotV1 = {
  kind: "pico.workflow-compiler-ledger";
  schemaVersion: 1;
  steps: Array<{
    order: number;
    node: string;
    tool: string;
    args: JsonObject;
    targetPath: string;
    cClass: string;
    status: "planned";
    note: string | null;
    execution: CompilerStepExecutionV1;
  }>;
  projectWrites: ProjectWriteRecordV1[];
};

export type PublicResultSnapshotV1 = {
  kind: "pico.workflow-public-result";
  schemaVersion: 1;
  workflow: RunWorkflowV1;
  status: PublicWorkflowStatusV1;
  publicResult: BuildAppPublicResultV1 | PicoLoopPublicResultV1;
};

export type SnapshotEnvelopeV1 =
  | GoalSnapshotV1 | AcceptanceSnapshotV1 | AppSpecSnapshotV1
  | BriefPayloadSnapshotV1 | ExternalInputSnapshotV1
  | CompilerLedgerSnapshotV1 | PublicResultSnapshotV1;

export type BuildWorkCommonV1 = {
  briefId: string;
  built: boolean;
  installed: boolean;
  verdict: string | null;
  autoJudgedRecorded: boolean;
  receiptId: Sha256 | null;
  receiptPath: string | null;
  capture: string | null;
  notes: string[];
  projectDir: string;
  identity?: string;
  honesty: string;
};

export type BuildAppPublicResultV1 =
  | { status: "needs-authoring"; scaffold: AppSpec; fix: string;
      archetype?: string; archetypeWhy?: string }
  | { status: "plan-failed"; detail: JsonValue; fix: string }
  | (BuildWorkCommonV1 & { status: "failed" | "built-not-installed" | "built-no-capture"; fix: string })
  | (BuildWorkCommonV1 & { status: "auto-judged-needs-look" | "built-needs-look" });

export type LoopPublicOutcomeV1 =
  | { kind: "build"; status: "fail"; detail: string }
  | { inputIndex: number; criterionDigest: Sha256;
      kind: "structural" | "visual" | "logcat" | "perf";
      status: "pass" | "fail" | "unmeasurable" | "needs-look";
      detail: string | null; machineVerdict: string | null;
      recordedEvidence: boolean | null; failureClass: string | null;
      machineChecks: JsonValue[] };

export type LoopIterationLogRowV1 = {
  iteration: number;
  outcomes: LoopPublicOutcomeV1[];
  capture: string | null;
  receiptId: Sha256 | null;
  receiptPath: string | null;
  ledger: string;
};

export type LoopExitCommonV1 = {
  iterations: number;
  briefId: string;
  projectDir: string;
  scaffoldStarted: boolean;
  iterationsLog: LoopIterationLogRowV1[];
  capture?: string | null;
  receiptId?: Sha256 | null;
  receiptPath?: string | null;
  perfTrend?: JsonValue[];
  perfEvidence?: string;
};

export type PicoLoopPublicResultV1 =
  | { status: "plan-failed"; iterations: 0; detail: JsonValue; fix: string }
  | (LoopExitCommonV1 & { status: "plan-failed"; detail: JsonValue; fix: string })
  | (LoopExitCommonV1 & { status: "budget-exhausted"; failing: LoopPublicOutcomeV1[]; fix: string })
  | (LoopExitCommonV1 & { status: "accepted";
      ceiling: "structural" | "auto_judged"; acceptanceScope: string;
      fleetVisualVerdict: string; remainingLookObligation: Array<{
        artifact: string | null; whatToConfirm: string }>;
      honesty: string })
  | (LoopExitCommonV1 & { status: "built-needs-look";
      needsLook: LoopPublicOutcomeV1[]; remainingLookObligation: Array<{
        artifact: string | null; whatToConfirm: string }>;
      honesty: string })
  | (LoopExitCommonV1 & { status: "unmeasurable-acceptance"; failing: LoopPublicOutcomeV1[]; fix: string })
  | (LoopExitCommonV1 & { status: "no-progress"; failing: LoopPublicOutcomeV1[]; detail?: JsonValue; fix: string })
  | (LoopExitCommonV1 & { status: "failed"; failing: LoopPublicOutcomeV1[]; fix: string })
  | (LoopExitCommonV1 & { status: "manual-repair-required"; failing: LoopPublicOutcomeV1[]; detail?: JsonValue; fix: string });

export type PreRunWorkflowFailureV1 =
  | { status: "plan-failed"; detail: JsonValue; fix: string }
  | { status: "plan-failed"; iterations: 0; detail: JsonValue; fix: string }
  | { status: "invalid-acceptance"; iterations: 0; fix: string };

export type ProjectLocatorV1 = {
  kind: "pico.project-locator";
  schemaVersion: 1;
  requestedProjectsRoot: string;
  physicalProjectsRoot: string;
  requestedProjectDir: string;
  physicalProjectDir: string;
  anchor: { requestedPath: string; physicalPath: string; device: string; inode: string };
  missingSuffix: string[];
};

export type BoundedDiagnosticV1 = { code: string; detail: string; detailSha256: Sha256 };

export type ExternalPhaseV1 =
  | "fleet-build" | "scaffold" | "compiler" | "generator" | "native-build"
  | "install" | "asset-delivery" | "launch" | "capture" | "receipt-publication"
  | "visual-judge" | "mouse-bridge" | "panel-launch" | "panel-probe"
  | "panel-capture" | "acceptance-logcat" | "acceptance-structural"
  | "acceptance-perf" | "structural-ledger" | "replan";

export type CompilerPhaseV1 = "fleet-build" | "scaffold" | "compiler" | "generator" | "asset-delivery" | "native-build";
export type StructuralLedgerResultV1 = { status: "recorded"; seq: number } | { status: "not-recorded"; reason: BoundedDiagnosticV1 };
export type BriefGenerationV1 = { status: "absent" } | { status: "observed"; bytes: number; sha256: Sha256 };
export type ProjectInputGenerationV1 =
  | { status: "absent" }
  | { status: "observed"; directory: { physicalPath: string; device: string; inode: string }; identity: {
      kind: "pico.gradle-input-generation"; schemaVersion: 1;
      policy: "pico-native-receipt-gradle-input-v1"; projectDir: string;
      algorithm: "sha256"; sha256: Sha256; entryCount: number; totalBytes: number } }
  | { status: "unobservable"; reason: string; reasonSha256: Sha256 };
export type TargetGenerationV1 = { brief: BriefGenerationV1; project: ProjectInputGenerationV1 };
export type ProjectGenerationStateV1 = {
  expected: TargetGenerationV1;
  lastAttempt: null | {
    attemptId: LowercaseUuidV4;
    before: TargetGenerationV1;
    after: TargetGenerationV1 | null;
    attribution: null | {
      status: "unchanged" | "fleet-write-set" | "receipt-and-fleet-write-set";
      compilerLedger: Sha256 | null;
      receiptId: Sha256 | null;
    };
  };
};

export type CompilerOutcomeV1 =
  | { status: "not-run" }
  | { status: "succeeded"; ledger: SnapshotRefV1 & { kind: "compiler-ledger" };
      plannedCount: number; completedCount: number; elapsedMs: number;
      executionDisposition: "definitely-completed" }
  | { status: "failed"; ledger: (SnapshotRefV1 & { kind: "compiler-ledger" }) | null;
      phase: CompilerPhaseV1; failure: BoundedDiagnosticV1;
      plannedCount: number; completedCount: number; elapsedMs: number;
      executionDisposition: "definitely-completed" }
  | { status: "in-doubt"; ledger: (SnapshotRefV1 & { kind: "compiler-ledger" }) | null;
      phase: CompilerPhaseV1; reason: BoundedDiagnosticV1;
      plannedCount: number | null; completedCount: number | null; elapsedMs: number | null;
      executionDisposition: "in-doubt" };

export type CriterionOutcomeV1 = Exclude<LoopPublicOutcomeV1, { kind: "build" }>;
export type PerfSampleV1 = { inputIndex: number; criterionDigest: Sha256; measurement: {
  iteration: number; p5: number; p10: number | null; p50: number | null; avg: number;
  jankWindows: number | null; reportPath: string | null } };
export type IterationStateV1 =
  | { status: "not-run"; nextIndex: 1; completedCount: 0; previousFailureSignature: null }
  | { status: "blocked"; index: number; completedCount: number; nextIndex: number;
      failure: BoundedDiagnosticV1; previousFailureSignature: string | null;
      structuralLedger: StructuralLedgerResultV1 }
  | { status: "completed"; index: number; completedCount: number; nextIndex: number;
      outcomes: CriterionOutcomeV1[]; previousFailureSignature: string | null;
      perfSamples: PerfSampleV1[]; structuralLedger: StructuralLedgerResultV1 };

export type PausedPublicStatusV1 =
  | "plan-failed" | "failed" | "built-not-installed" | "built-no-capture"
  | "unmeasurable-acceptance" | "no-progress" | "manual-repair-required";
export type TerminalPublicStatusV1 = "built-needs-look" | "auto-judged-needs-look" | "accepted" | "budget-exhausted" | "failed";
export type LifecycleV1 =
  | { status: "open"; phase: "ready-to-plan" | "awaiting-authoring" | "ready-to-build"; publicStatus: "needs-authoring" | null }
  | { status: "running"; phase: "attempt-started" | "attempt-in-doubt"; attemptId: LowercaseUuidV4 }
  | { status: "paused"; publicStatus: PausedPublicStatusV1 }
  | { status: "blocked"; reason: "external-state-conflict"; attemptId: LowercaseUuidV4 }
  | { status: "terminal"; publicStatus: TerminalPublicStatusV1 };

export type ExternalMutationDispositionV1 = "none" | "possible" | "confirmed";
export type TransitionV1 =
  | { type: "created" }
  | { type: "plan-completed"; outcome: "awaiting-authoring" | "ready-to-build" | "plan-failed"; diagnostic: BoundedDiagnosticV1 | null }
  | { type: "spec-authored"; previousSpec: Sha256; currentSpec: Sha256 }
  | { type: "spec-amended"; previousSpec: Sha256 | null; currentSpec: Sha256 }
  | { type: "attempt-started"; attemptId: LowercaseUuidV4; phase: "build" | "loop-iteration"; iteration: number | null; generation: TargetGenerationV1; inputs: Sha256 }
  | { type: "attempt-in-doubt"; attemptId: LowercaseUuidV4; phase: ExternalPhaseV1; reason: BoundedDiagnosticV1; externalMutationDisposition: "possible" | "confirmed" }
  | { type: "attempt-paused"; attemptId: LowercaseUuidV4; phase: ExternalPhaseV1; publicStatus: PausedPublicStatusV1; failure: BoundedDiagnosticV1; externalMutationDisposition: ExternalMutationDispositionV1 }
  | { type: "attempt-conflicted"; attemptId: LowercaseUuidV4; reason: BoundedDiagnosticV1; observed: TargetGenerationV1; externalMutationDisposition: ExternalMutationDispositionV1 }
  | { type: "iteration-completed"; attemptId: LowercaseUuidV4; iteration: number; next: "ready-to-build"; externalMutationDisposition: ExternalMutationDispositionV1 }
  | { type: "run-terminal"; attemptId: LowercaseUuidV4; publicStatus: TerminalPublicStatusV1; externalMutationDisposition: ExternalMutationDispositionV1 }
  | { type: "policy-terminal"; reason: "time-budget-exhausted" | "iteration-budget-exhausted"; publicStatus: "budget-exhausted" };

export type NativeReceiptRefV1 = { kind: "pico.native-run-receipt"; schemaVersion: 1; app: string; receiptId: Sha256; captureSha256: Sha256 };
export type AutoJudgeEventRefV1 = { kind: "pico.auto-judge-ledger-event"; schemaVersion: 1; app: string; seq: number; eventDigest: Sha256; receiptId: Sha256; captureSha256: Sha256 };

export type RunRevisionV1 = {
  kind: "pico.workflow-run-revision"; schemaVersion: 1; runId: LowercaseUuidV4;
  revision: number; revisionId: Sha256; parent: null | { revision: number; revisionId: Sha256 };
  createdAt: CanonicalUtcTimestamp; workflow: RunWorkflowV1;
  intent: {
    goal: SnapshotRefV1 & { kind: "goal" };
    acceptance: (SnapshotRefV1 & { kind: "acceptance" }) | null;
    initialSpec: (SnapshotRefV1 & { kind: "app-spec" }) | null;
    currentSpec: null | { snapshot: SnapshotRefV1 & { kind: "app-spec" };
      origin: "planner-scaffold" | "caller-authored" | "retained-lesson-repair" | "explicit-amendment";
      amendsRevision: number | null };
    briefPayload: (SnapshotRefV1 & { kind: "brief-payload" }) | null;
    budget: null | { iterations: number; timeMin: number; toolCalls: "inert" };
    onFail: null | "replan" | "stop";
    execution: { fleetSettleSec: 16 };
  };
  target: {
    briefInput: string; briefId: string; app: string; executionSerial: "emulator-5554";
    inputBaseDir: string; briefPath: string; projectDir: string; projectLocator: ProjectLocatorV1;
    resourceKey: Sha256; projectResourceKey: Sha256;
    base: null | { runId: LowercaseUuidV4; revision: number; revisionId: Sha256 };
  };
  transition: TransitionV1; projectGeneration: ProjectGenerationStateV1;
  attemptInputs: (SnapshotRefV1 & { kind: "external-input" }) | null;
  compiler: CompilerOutcomeV1; receiptReferences: NativeReceiptRefV1[];
  autoJudgeEvidence: AutoJudgeEventRefV1 | null; iteration: IterationStateV1;
  publicResult: (SnapshotRefV1 & { kind: "public-result" }) | null;
  lifecycle: LifecycleV1; storedEvidenceCeiling: "structural" | "auto_judged";
};
export type RunTargetV1 = RunRevisionV1["target"];

export type RunHeadV1 = { kind: "pico.workflow-run-head"; schemaVersion: 1; runId: LowercaseUuidV4; revision: number; revisionId: Sha256; updatedAt: CanonicalUtcTimestamp };

export type AppSpecInput = unknown;
export type AcceptanceInput = Array<{
  kind: "structural" | "visual" | "logcat" | "perf";
  entitiesPresent?: string[]; minEntities?: number; componentsPresent?: string[];
  pattern?: string; tag?: string; timeoutSec?: number;
  minAppFpsP5?: number; durationSec?: number;
}>;
export type BudgetInput = { iterations?: number; timeMin?: number; toolCalls?: number };
export type TargetBaseV1 = { runId: LowercaseUuidV4; revision: number; revisionId: Sha256 };
export type BuildAppInvocationV1 =
  | { mode: "coordinate-free"; brief: string; draftSpec?: AppSpecInput }
  | { mode: "initial-from-base"; brief: string; draftSpec?: AppSpecInput; targetBase: TargetBaseV1 }
  | { mode: "resume"; runId: LowercaseUuidV4; expectedRevision: number; brief?: string }
  | { mode: "author"; runId: LowercaseUuidV4; expectedRevision: number; brief?: string; draftSpec: AppSpecInput }
  | { mode: "amend"; runId: LowercaseUuidV4; expectedRevision: number; brief?: string; replacementSpec: AppSpecInput };
export type ResolvedCoordinateFreeBuildV1 =
  | { mode: "initial"; brief: string; draftSpec?: AppSpecInput }
  | { mode: "legacy-scaffold-replay"; runId: LowercaseUuidV4; expectedRevision: number; brief: string }
  | { mode: "legacy-author"; runId: LowercaseUuidV4; expectedRevision: number; brief: string; draftSpec: AppSpecInput };
export type PicoLoopInvocationV1 =
  | { mode: "initial"; goal: string; acceptance: AcceptanceInput; draftSpec?: AppSpecInput; budget?: BudgetInput; onFail?: "replan" | "stop"; targetBase?: TargetBaseV1 }
  | { mode: "resume"; runId: LowercaseUuidV4; expectedRevision: number; goal?: string; acceptance?: AcceptanceInput; budget?: BudgetInput; onFail?: "replan" | "stop" }
  | { mode: "amend"; runId: LowercaseUuidV4; expectedRevision: number; replacementSpec: AppSpecInput; goal?: string; acceptance?: AcceptanceInput; budget?: BudgetInput; onFail?: "replan" | "stop" };

export type RunControlStatusV1 =
  | "invalid-invocation" | "invalid-policy" | "invalid-run-id" | "run-not-found"
  | "run-busy" | "revision-conflict" | "intent-conflict" | "acceptance-conflict"
  | "spec-conflict" | "target-conflict" | "recovery-required"
  | "interrupted-in-doubt" | "external-state-conflict"
  | "invalid-store" | "limit-exceeded" | "revision-limit" | "state-write-failed";
export type RunControlResultV1 = {
  status: RunControlStatusV1; runId: LowercaseUuidV4 | null; revision: number | null;
  revisionId: Sha256 | null; expectedRevision: number | null; actualRevision: number | null;
  actualRevisionId: Sha256 | null;
  runStateByThisCall: "unchanged" | "durably-advanced" | "publication-in-doubt";
  externalSideEffectsByThisCall: "none" | "possible" | "confirmed";
  priorAttemptExternalSideEffects: "possible" | "confirmed" | null;
  activeAttemptExternalSideEffects: "possible" | null;
  inDoubtAttemptCompletion: "unknown" | null;
  runRevisionCommitted: boolean | null;
  runRevisionPublication: "not-linked" | "linked-head-pending" | "head-authoritative" | "unknown" | null;
  expectedGeneration: TargetGenerationV1 | null; observedGeneration: TargetGenerationV1 | null;
  historicalResult: BuildAppPublicResultV1 | PicoLoopPublicResultV1 | null;
  issues: BoundedDiagnosticV1[]; detail: string; fix: string;
};

export type BuildInvocationParseV1 =
  | { ok: true; value: BuildAppInvocationV1 }
  | { ok: false; result: RunControlResultV1 & { status: "invalid-invocation" } };
export type LoopInvocationParseV1 =
  | { ok: true; value: PicoLoopInvocationV1 }
  | { ok: false; result: RunControlResultV1 & { status: "invalid-invocation" | "invalid-policy" } };
export type NormalizedRunIntentV1 = Readonly<{
  workflow: RunWorkflowV1; goal: GoalSnapshotV1; acceptance: AcceptanceSnapshotV1 | null;
  initialSpec: AppSpecSnapshotV1 | null;
  budget: null | { iterations: number; timeMin: number; toolCalls: "inert" };
  onFail: null | "replan" | "stop"; execution: { fleetSettleSec: 16 };
}>;
export type NormalizedLoopPolicyV1 = Readonly<{
  budget: { iterations: number; timeMin: number; toolCalls: "inert" };
  onFail: "replan" | "stop";
}>;
export type RunStoreMutationRequestV1 = Readonly<{
  runId: LowercaseUuidV4; expectedRevision: number | null; ownerToken: LowercaseUuidV4;
  mode: "coordination" | "execution" | "recovery";
}>;
export type ExternalPhaseCallResultV1<T> =
  | { executionDisposition: "definitely-completed"; externalMutationDisposition: "none" | "possible" | "confirmed"; value: T }
  | { executionDisposition: "in-doubt"; externalMutationDisposition: "possible" | "confirmed"; phase: ExternalPhaseV1; reason: BoundedDiagnosticV1 };

export type FleetCompilerSummaryV1 =
  | { status: "not-run" }
  | { status: "succeeded"; ledger: CompilerLedgerSnapshotV1; plannedCount: number; completedCount: number; elapsedMs: number }
  | { status: "failed"; ledger: CompilerLedgerSnapshotV1 | null; phase: CompilerPhaseV1; failure: BoundedDiagnosticV1; plannedCount: number; completedCount: number; elapsedMs: number }
  | { status: "in-doubt"; ledger: CompilerLedgerSnapshotV1 | null; phase: CompilerPhaseV1; reason: BoundedDiagnosticV1; plannedCount: number | null; completedCount: number | null; elapsedMs: number | null };
export type FleetReceiptSummaryV1 = {
  status: "recorded"; receiptId: Sha256; receiptPath: string; capturePath: string;
  sourceCapturePath: string; captureSha256: Sha256; evidenceType: "structural"; lookRequired: true;
};
export type NativeFleetFailureStageV1 =
  | "adb-resolution" | "source-identity" | "build" | "build-input-continuity"
  | "apk-resolution" | "apk-publication" | "apk-inspection"
  | "install" | "installed-byte-identity" | "after-install"
  | "device-identity" | "launch" | "pid" | "foreground"
  | "capture" | "capture-publication" | "receipt-publication";
export type FleetResultV1 = {
  id: string; built: boolean; installed: boolean; concluded: boolean;
  verdict: string | null; artifact: string | null; receipt: FleetReceiptSummaryV1 | null;
  verificationRoute: JsonValue | null; visualExpectation: JsonValue | null;
  visualClaim: string | null; splatAssets: JsonValue | null; confidence: number | null;
  visualChecks: JsonValue[]; visualJudgeNote: string | null; visualLedger: JsonValue | null;
  visualJudgeArtifact: string | null; panelEvidence: JsonValue | null; panelArtifact: string | null;
  nativeFailure: null | { stage: NativeFleetFailureStageV1; reason: string; completedStages: string[] };
  externalImplementation: JsonValue | null; notes: string[];
};
export type FleetInputBindingV1 =
  | { mode: "sealed"; briefPayloadSha256: Sha256; externalInputSha256: Sha256 }
  | { mode: "legacy-mutable"; briefPayloadSha256: Sha256; externalInputSha256: null };
export type FleetExecutionEnvelopeV1 =
  | { kind: "pico.fleet-execution"; schemaVersion: 1; inputBinding: FleetInputBindingV1;
      resourceKey: Sha256; projectResourceKey: Sha256; physicalProjectDir: string;
      executionDisposition: "definitely-completed"; phase: "complete" | ExternalPhaseV1;
      externalMutationDisposition: "none" | "possible" | "confirmed";
      compiler: FleetCompilerSummaryV1; definiteReceipt: FleetReceiptSummaryV1 | null; result: FleetResultV1 }
  | { kind: "pico.fleet-execution"; schemaVersion: 1; inputBinding: FleetInputBindingV1;
      resourceKey: Sha256; projectResourceKey: Sha256; physicalProjectDir: string;
      executionDisposition: "in-doubt"; phase: ExternalPhaseV1;
      externalMutationDisposition: "possible" | "confirmed";
      compiler: FleetCompilerSummaryV1; definiteReceipt: FleetReceiptSummaryV1 | null;
      reason: BoundedDiagnosticV1 };

export type EffectiveLifecycleV1 = LifecycleV1 | { status: "provenance-broken"; storedStatus: TerminalPublicStatusV1 };
export type EffectivePublicStatusV1 = PublicWorkflowStatusV1 | "provenance-broken";
export type RunProjectionMetadataV1 = {
  projection: "exact" | "authority-stripped" | "auto-downgraded" | "provenance-broken";
  runId: LowercaseUuidV4; revision: number; revisionId: Sha256; replayed: boolean;
  storedLifecycle: LifecycleV1; effectiveLifecycle: EffectiveLifecycleV1;
  storedStatus: PublicWorkflowStatusV1 | null; effectiveStatus: EffectivePublicStatusV1 | null;
  storedEvidenceCeiling: "structural" | "auto_judged";
  effectiveEvidenceCeiling: "structural" | "auto_judged";
  claimedReceiptReferences: NativeReceiptRefV1[]; effectiveReceiptReferences: NativeReceiptRefV1[];
  receiptProvenance: BoundedDiagnosticV1[];
  autoJudgeProvenance: null | { status: "valid" | "unverifiable"; issues: BoundedDiagnosticV1[]; issueCount: number; issuesTruncated: boolean };
  historicalResult: BuildAppPublicResultV1 | PicoLoopPublicResultV1 | null;
  runStateByThisCall: "unchanged"; externalSideEffectsByThisCall: "none";
};
export type ProjectionMetaV1<P extends RunProjectionMetadataV1["projection"]> =
  Omit<RunProjectionMetadataV1, "projection" | "replayed"> & { projection: P; replayed: true };
export type HistoricalProjectionMetaV1<P extends Exclude<RunProjectionMetadataV1["projection"], "exact">> =
  Omit<ProjectionMetaV1<P>, "historicalResult"> & { historicalResult: BuildAppPublicResultV1 | PicoLoopPublicResultV1 };
export type BuildFailureProjectionV1 = { kind: "build"; status: "fail"; detail: string };
export type SanitizedNonVisualOutcomeV1 = {
  inputIndex: number; criterionDigest: Sha256; kind: "structural" | "logcat" | "perf";
  status: "pass" | "fail" | "unmeasurable"; detail: string | null; failureClass: string | null;
};
export type SanitizedIterationLogRowV1 = {
  iteration: number; outcomes: Array<SanitizedNonVisualOutcomeV1 | BuildFailureProjectionV1>;
  omittedVisualOutcomeCount: number; ledger: string;
};
export type AuthorityStrippedReplayV1 = HistoricalProjectionMetaV1<"authority-stripped"> & {
  status: PublicWorkflowStatusV1; summary: { workflow: RunWorkflowV1; briefId: string | null;
    projectDir: string | null; built: boolean | null; installed: boolean | null;
    iterations: number | null; scaffoldStarted: boolean | null; iterationsLog: SanitizedIterationLogRowV1[] };
  detail: string; fix: string;
};
export type AutoDowngradedReplayV1 = HistoricalProjectionMetaV1<"auto-downgraded"> & {
  status: "built-needs-look"; briefId: string; built: boolean; installed: boolean;
  autoJudgedRecorded: false; receiptId: Sha256; receiptPath: string; capture: string;
  projectDir: string; honesty: string; fix: string;
};
export type ProvenanceBrokenReplayV1 = HistoricalProjectionMetaV1<"provenance-broken"> & {
  status: "provenance-broken"; detail: string; fix: string;
};
export type ReplayResultV1 =
  | (ProjectionMetaV1<"exact"> & { historicalResult: null } & (BuildAppPublicResultV1 | PicoLoopPublicResultV1))
  | AuthorityStrippedReplayV1 | AutoDowngradedReplayV1 | ProvenanceBrokenReplayV1;

function fail(message: string): never { throw new Error(message); }
function sha256(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }

function inspectCanonical(value: unknown, maxBytes: number, label: string, maxStringBytes = STRING_MAX_BYTES): void {
  const visit = (node: unknown, depth: number, ancestors: Set<object>): void => {
    if (node === null || typeof node === "boolean") return;
    if (typeof node === "string") { if (Buffer.byteLength(node) > maxStringBytes) fail(`${label} string limit exceeded`); return; }
    if (typeof node === "number") { if (!Number.isFinite(node)) fail(`${label} numbers must be finite`); return; }
    if (typeof node !== "object") fail(`${label} contains unsupported canonical JSON value`);
    if (depth >= JSON_MAX_DEPTH) fail(`${label} nesting limit exceeded`);
    if (ancestors.has(node)) fail(`${label} contains a cycle`);
    ancestors.add(node);
    try {
      if (Array.isArray(node)) {
        if (Object.getPrototypeOf(node) !== Array.prototype) fail(`${label} has unsupported array prototype`);
        if (node.length > JSON_MAX_ARRAY) fail(`${label} array limit exceeded`);
        const keys = Reflect.ownKeys(node).filter((key) => key !== "length");
        if (keys.length !== node.length) fail(`${label} array is sparse or has extra properties`);
        for (let index = 0; index < node.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(node, String(index));
          if (!descriptor?.enumerable || !("value" in descriptor)) fail(`${label} array has an accessor`);
          visit(descriptor.value, depth + 1, ancestors);
        }
      } else {
        const prototype = Object.getPrototypeOf(node);
        if (prototype !== Object.prototype && prototype !== null) fail(`${label} has unsupported object prototype`);
        const keys = Reflect.ownKeys(node);
        if (keys.some((key) => typeof key !== "string") || keys.length > JSON_MAX_KEYS) fail(`${label} object key limit exceeded`);
        for (const key of keys as string[]) {
          const descriptor = Object.getOwnPropertyDescriptor(node, key);
          if (!descriptor?.enumerable || !("value" in descriptor)) fail(`${label} object has an accessor or hidden property`);
          if (Buffer.byteLength(key) > STRING_MAX_BYTES) fail(`${label} key limit exceeded`);
          visit(descriptor.value, depth + 1, ancestors);
        }
      }
    } finally { ancestors.delete(node); }
  };
  visit(value, 0, new Set());
  if (Buffer.byteLength(canonicalJson(value)) > maxBytes) fail(`${label} canonical byte limit exceeded`);
}

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value);
  const expected = new Set(keys);
  if (actual.length !== keys.length || actual.some((key) => !expected.has(key))) fail(`${label} has unknown or missing keys`);
  return value as Record<string, unknown>;
}

function recordOptional(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(object).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(object, key))) fail(`${label} has unknown or missing keys`);
  return object;
}

function literal<T extends string | number | boolean>(value: unknown, expected: T, label: string): T { if (value !== expected) fail(`${label} must be ${String(expected)}`); return expected; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T { if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${label} is invalid`); return value as T; }
function boundedString(value: unknown, label: string, maxBytes: number, allowEmpty = true): string { if (typeof value !== "string" || (!allowEmpty && value.length === 0) || Buffer.byteLength(value) > maxBytes) fail(`${label} must be a bounded string`); return value; }
function stringValue(value: unknown, label: string, allowEmpty = true): string { return boundedString(value, label, STRING_MAX_BYTES, allowEmpty); }
function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(`${label} must be a safe integer in range`); return value as number; }
function publicSchemaInteger(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) fail(`${label} must be a finite integer`); return value; }
function finite(value: unknown, label: string, min = -Infinity, max = Infinity): number { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be a finite number in range`); return value; }
function bool(value: unknown, label: string): boolean { if (typeof value !== "boolean") fail(`${label} must be boolean`); return value; }
function nullableString(value: unknown, label: string): string | null { return value === null ? null : stringValue(value, label); }
function shaValue(value: unknown, label: string): Sha256 { if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(`${label} must be lowercase sha256`); return value; }
function uuidValue(value: unknown, label: string): LowercaseUuidV4 { if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) fail(`${label} must be lowercase UUID v4`); return value; }
function absolutePath(value: unknown, label: string, maxBytes = STRING_MAX_BYTES): string { const result = boundedString(value, label, maxBytes, false); if (!path.isAbsolute(result) || path.normalize(result) !== result) fail(`${label} must be a canonical absolute path`); return result; }
function timestamp(value: unknown, label: string): CanonicalUtcTimestamp { const result = stringValue(value, label, false); const time = Date.parse(result); if (!Number.isFinite(time) || new Date(time).toISOString() !== result) fail(`${label} must be a canonical UTC timestamp`); return result; }
function optionalNullableNumber(value: unknown, label: string): number | null { return value === null ? null : finite(value, label); }

function scrubDiagnostic(detail: string): string {
  return detail.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g, "");
}
function assertBoundedCode(code: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(code)) fail("diagnostic code must use the bounded code grammar");
  return code;
}

export function boundedDiagnostic(code: string, detail: string): BoundedDiagnosticV1 {
  const retained = scrubDiagnostic(stringValue(detail, "diagnostic detail"));
  const bytes = Buffer.from(retained);
  let end = Math.min(bytes.length, DIAGNOSTIC_MAX_BYTES);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return {
    code: assertBoundedCode(code),
    detail: bytes.subarray(0, end).toString("utf8"),
    detailSha256: sha256(retained),
  };
}

export function normalizeGoal(original: string): { original: string; normalized: string; digest: string } {
  boundedString(original, "goal", ORIGINAL_GOAL_MAX_BYTES);
  const normalized = original.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (!normalized || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(normalized)) fail("goal must be nonempty and contain no control characters except tab/newline");
  if (Buffer.byteLength(normalized) > STRING_MAX_BYTES) fail("goal string limit exceeded");
  const envelope: GoalSnapshotV1 = { kind: "pico.workflow-goal", schemaVersion: 1, goal: normalized };
  return { original, normalized, digest: sha256(canonicalJson(envelope)) };
}

function strictCriterion(value: unknown, inputIndex: number, normalize: boolean): StrictAcceptanceCriterionV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("acceptance criterion must be an object");
  const source = value as Record<string, unknown>;
  const kind = oneOf(source.kind, ["structural", "visual", "logcat", "perf"] as const, "criterion kind");
  let payload: StrictAcceptanceCriterionPayloadV1;
  if (normalize) {
    if (kind === "structural") {
      const entitiesPresent = source.entitiesPresent ?? [];
      const componentsPresent = source.componentsPresent ?? [];
      if (!Array.isArray(entitiesPresent) || !Array.isArray(componentsPresent)) fail("structural arrays are invalid");
      payload = { kind, inputIndex, entitiesPresent: entitiesPresent.map((item) => stringValue(item, "entity")), minEntities: source.minEntities === undefined ? null : integer(source.minEntities, "minEntities"), componentsPresent: componentsPresent.map((item) => stringValue(item, "component")) };
    } else if (kind === "visual") payload = { kind, inputIndex };
    else if (kind === "logcat") {
      payload = { kind, inputIndex, pattern: stringValue(source.pattern, "logcat pattern", false), tag: source.tag ? stringValue(source.tag, "logcat tag") : null, timeoutSec: source.timeoutSec === undefined ? 20 : integer(source.timeoutSec, "timeoutSec", 1, 180) };
    } else payload = { kind, inputIndex, minAppFpsP5: source.minAppFpsP5 === undefined ? 60 : finite(source.minAppFpsP5, "minAppFpsP5", 0, Number.MAX_SAFE_INTEGER), durationSec: source.durationSec ? integer(source.durationSec, "durationSec", 5, 120) : 15 };
    return { ...payload, criterionDigest: sha256(canonicalJson(payload)) } as StrictAcceptanceCriterionV1;
  }
  const keys = kind === "structural"
    ? ["kind", "inputIndex", "criterionDigest", "entitiesPresent", "minEntities", "componentsPresent"]
    : kind === "visual" ? ["kind", "inputIndex", "criterionDigest"]
    : kind === "logcat" ? ["kind", "inputIndex", "criterionDigest", "pattern", "tag", "timeoutSec"]
    : ["kind", "inputIndex", "criterionDigest", "minAppFpsP5", "durationSec"];
  record(value, keys, `${kind} criterion`);
  const storedIndex = integer(source.inputIndex, "inputIndex");
  if (storedIndex !== inputIndex) fail("criterion inputIndex must preserve array position");
  if (kind === "structural") {
    if (!Array.isArray(source.entitiesPresent) || !Array.isArray(source.componentsPresent)) fail("structural arrays are invalid");
    payload = { kind, inputIndex: storedIndex, entitiesPresent: source.entitiesPresent.map((item) => stringValue(item, "entity")), minEntities: source.minEntities === null ? null : integer(source.minEntities, "minEntities"), componentsPresent: source.componentsPresent.map((item) => stringValue(item, "component")) };
  } else if (kind === "visual") payload = { kind, inputIndex: storedIndex };
  else if (kind === "logcat") payload = { kind, inputIndex: storedIndex, pattern: stringValue(source.pattern, "logcat pattern", false), tag: source.tag === null ? null : stringValue(source.tag, "tag"), timeoutSec: integer(source.timeoutSec, "timeoutSec", 1, 180) };
  else payload = { kind, inputIndex: storedIndex, minAppFpsP5: finite(source.minAppFpsP5, "minAppFpsP5", 0, Number.MAX_SAFE_INTEGER), durationSec: integer(source.durationSec, "durationSec", 5, 120) };
  const digest = shaValue(source.criterionDigest, "criterionDigest");
  if (digest !== sha256(canonicalJson(payload))) fail("criterionDigest mismatch");
  return { ...payload, criterionDigest: digest } as StrictAcceptanceCriterionV1;
}

export function normalizeAcceptance(criteria: unknown[]): { envelope: AcceptanceSnapshotV1; refDigest: string } {
  canonicalJson(criteria);
  if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > RUN_ACCEPTANCE_MAX) fail("acceptance must contain 1..64 criteria");
  const envelope: AcceptanceSnapshotV1 = { kind: "pico.workflow-acceptance", schemaVersion: 1, criteria: criteria.map((criterion, index) => strictCriterion(criterion, index, true)) };
  inspectCanonical(envelope, RUN_ACCEPTANCE_MAX_BYTES, "normalized acceptance");
  const canonical = canonicalJson(envelope);
  if (Buffer.byteLength(canonical) > RUN_ACCEPTANCE_MAX_BYTES) fail("acceptance canonical byte limit exceeded");
  return { envelope, refDigest: sha256(canonical) };
}

export function normalizeLoopPolicy(budget: unknown, onFail: unknown): NormalizedLoopPolicyV1 {
  if (budget !== undefined) inspectCanonical(budget, STRING_MAX_BYTES, "budget");
  const source = budget === undefined ? {} : recordOptional(budget, [], ["iterations", "timeMin", "toolCalls"], "budget");
  const iterations = source.iterations === undefined ? 3 : integer(source.iterations, "iterations", 1, 6);
  const timeMin = source.timeMin === undefined ? 20 : finite(source.timeMin, "timeMin", 0, 1440);
  if (source.toolCalls !== undefined) publicSchemaInteger(source.toolCalls, "toolCalls");
  const failurePolicy = onFail === undefined ? "replan" : oneOf(onFail, ["replan", "stop"] as const, "onFail");
  return { budget: { iterations, timeMin, toolCalls: "inert" }, onFail: failurePolicy };
}

function parseDiagnostic(value: unknown, label = "diagnostic"): BoundedDiagnosticV1 {
  const object = record(value, ["code", "detail", "detailSha256"], label);
  const code = stringValue(object.code, `${label}.code`, false);
  assertBoundedCode(code);
  const detail = stringValue(object.detail, `${label}.detail`);
  if (Buffer.byteLength(detail) > DIAGNOSTIC_MAX_BYTES) fail(`${label}.detail exceeds projection limit`);
  return { code, detail, detailSha256: shaValue(object.detailSha256, `${label}.detailSha256`) };
}

function parseSnapshotRef(value: unknown, expectedKind?: SnapshotRefV1["kind"]): SnapshotRefV1 {
  const object = record(value, ["kind", "algorithm", "sha256", "bytes"], "snapshot ref");
  const kind = oneOf(object.kind, ["goal", "acceptance", "app-spec", "brief-payload", "external-input", "compiler-ledger", "public-result"] as const, "snapshot ref kind");
  if (expectedKind !== undefined && kind !== expectedKind) fail("snapshot ref kind mismatch");
  const bytes = integer(object.bytes, "snapshot bytes");
  const maxBytes = kind === "goal" ? STRING_MAX_BYTES + 1_024
    : kind === "acceptance" ? RUN_ACCEPTANCE_MAX_BYTES
      : kind === "app-spec" ? APP_SPEC_SNAPSHOT_MAX_BYTES
        : kind === "brief-payload" ? BRIEF_PAYLOAD_SNAPSHOT_MAX_BYTES
          : kind === "external-input" ? EXTERNAL_INPUT_SNAPSHOT_MAX_BYTES
            : kind === "compiler-ledger" ? COMPILER_LEDGER_MAX_BYTES
              : PUBLIC_RESULT_MAX_BYTES;
  if (bytes > maxBytes) fail("snapshot ref byte limit exceeded");
  return { kind, algorithm: literal(object.algorithm, "sha256", "snapshot algorithm"), sha256: shaValue(object.sha256, "snapshot sha256"), bytes };
}

function parseHashSize(value: unknown, label: string): { bytes: number; sha256: Sha256 } {
  const object = record(value, ["bytes", "sha256"], label);
  return { bytes: integer(object.bytes, `${label}.bytes`), sha256: shaValue(object.sha256, `${label}.sha256`) };
}

function parseCompilerLedger(value: unknown): CompilerLedgerSnapshotV1 {
  const object = record(value, ["kind", "schemaVersion", "steps", "projectWrites"], "compiler ledger envelope");
  literal(object.kind, "pico.workflow-compiler-ledger", "compiler ledger kind");
  literal(object.schemaVersion, 1, "compiler ledger schemaVersion");
  if (!Array.isArray(object.steps) || object.steps.length > COMPILER_LEDGER_MAX_STEPS) fail("compiler ledger steps limit exceeded");
  const steps = object.steps.map((entry, index) => {
    const step = recordOptional(entry, ["order", "node", "tool", "args", "targetPath", "cClass", "status", "execution"], ["note"], "compiler step");
    if (integer(step.order, "compiler step order") !== index) fail("compiler step order must be contiguous");
    if (step.args === null || typeof step.args !== "object" || Array.isArray(step.args)) fail("compiler step args must be a JSON object");
    const execution = record(step.execution, ["disposition", "outputConfirmation", "detailDigest"], "compiler step execution");
    const disposition = oneOf(execution.disposition, ["scaffolded", "reused-project", "executed-success", "native-stage-success", "executed-failed", "native-stage-failed", "not-attempted", "in-doubt"] as const, "execution disposition");
    const outputConfirmation = oneOf(execution.outputConfirmation, ["confirmed", "unconfirmed", "not-applicable"] as const, "output confirmation");
    if (disposition === "not-attempted" && outputConfirmation !== "not-applicable") fail("not-attempted output must be not-applicable");
    if (["scaffolded", "reused-project", "native-stage-success"].includes(disposition) && outputConfirmation === "unconfirmed") fail("successful scaffold/native execution cannot have unconfirmed output");
    const detailDigest = execution.detailDigest === null ? null : shaValue(execution.detailDigest, "execution detailDigest");
    if (outputConfirmation === "unconfirmed" && detailDigest === null) fail("unconfirmed execution requires a diagnostic digest");
    if (disposition === "not-attempted" && detailDigest !== null) fail("not-attempted execution cannot carry a diagnostic digest");
    return {
      order: index, node: stringValue(step.node, "compiler node"), tool: stringValue(step.tool, "compiler tool"),
      args: step.args as JsonObject, targetPath: stringValue(step.targetPath, "compiler targetPath"),
      cClass: stringValue(step.cClass, "compiler cClass"), status: literal(step.status, "planned", "compiler step status"),
      note: step.note === undefined ? null : nullableString(step.note, "compiler note"), execution: {
        disposition, outputConfirmation,
        detailDigest,
      },
    };
  });
  if (!Array.isArray(object.projectWrites) || object.projectWrites.length > COMPILER_LEDGER_MAX_WRITES) fail("projectWrites limit exceeded");
  const projectWrites = object.projectWrites.map((entry) => {
    const write = record(entry, ["path", "origin", "stepOrder", "before", "after"], "project write");
    const writePath = stringValue(write.path, "project write path", false);
    if (path.posix.isAbsolute(writePath) || writePath.includes("\\") || writePath.split("/").some((part) => !part || part === "." || part === "..")) fail("project write path must be canonical relative");
    const before = write.before === null ? null : parseHashSize(write.before, "project write before");
    const after = write.after === null ? null : parseHashSize(write.after, "project write after");
    if (canonicalJson(before) === canonicalJson(after)) fail("project write cannot be a no-op");
    const stepOrder = write.stepOrder === null ? null : integer(write.stepOrder, "project write stepOrder");
    if (stepOrder !== null && stepOrder >= steps.length) fail("project write stepOrder out of range");
    return { path: writePath, origin: oneOf(write.origin, ["scaffold", "compiler-step", "asset-delivery", "fleet-runtime"] as const, "project write origin"), stepOrder, before, after };
  });
  const lastAfterByPath = new Map<string, ProjectWriteRecordV1["after"]>();
  for (const write of projectWrites) {
    if (lastAfterByPath.has(write.path) && canonicalJson(write.before) !== canonicalJson(lastAfterByPath.get(write.path))) fail("project write chain is broken");
    lastAfterByPath.set(write.path, write.after);
  }
  return { kind: "pico.workflow-compiler-ledger", schemaVersion: 1, steps, projectWrites };
}

function parseExternalInput(value: unknown): ExternalInputSnapshotV1 {
  const object = record(value, ["kind", "schemaVersion", "policy", "appSpecSha256", "briefPayloadSha256", "resourceKey", "projectResourceKey", "physicalProjectDir", "inputBaseDir", "iblSelector", "uses", "files", "iblChoices", "uniqueFileCount", "totalBytes"], "external input envelope");
  literal(object.kind, "pico.workflow-external-input", "external input kind");
  literal(object.schemaVersion, 1, "external input schemaVersion");
  literal(object.policy, "pico-fleet-external-input-v1", "external input policy");
  let iblSelector: ExternalInputSnapshotV1["iblSelector"] = null;
  if (object.iblSelector !== null) {
    const selector = record(object.iblSelector, ["userIblDir", "corpusBriefsDir", "selected", "selectedPhysicalDir", "reason"], "ibl selector");
    iblSelector = {
      userIblDir: absolutePath(selector.userIblDir, "userIblDir", EXTERNAL_PATH_MAX_BYTES), corpusBriefsDir: absolutePath(selector.corpusBriefsDir, "corpusBriefsDir", EXTERNAL_PATH_MAX_BYTES),
      selected: oneOf(selector.selected, ["user", "corpus"] as const, "ibl selected"), selectedPhysicalDir: absolutePath(selector.selectedPhysicalDir, "selectedPhysicalDir", EXTERNAL_PATH_MAX_BYTES),
      reason: oneOf(selector.reason, ["safe-user-ibl-directory-present", "user-ibl-directory-absent"] as const, "ibl reason"),
    };
  }
  if (!Array.isArray(object.uses) || !Array.isArray(object.files) || !Array.isArray(object.iblChoices)) fail("external input collections must be arrays");
  if (object.uses.length > EXTERNAL_INPUT_MAX_ENTRIES || object.files.length > EXTERNAL_INPUT_MAX_ENTRIES) fail("external input use/file limit exceeded");
  const uses = object.uses.map((entry, index) => {
    const use = record(entry, ["order", "jsonPointer", "role", "declaredPath", "resolvedPath", "fileIndex"], "external input use");
    if (integer(use.order, "use order") !== index) fail("external use order must be contiguous");
    const fileIndex = use.fileIndex === null ? null : integer(use.fileIndex, "fileIndex");
    if (fileIndex !== null && fileIndex >= (object.files as unknown[]).length) fail("external use fileIndex out of range");
    return { order: index, jsonPointer: boundedString(use.jsonPointer, "jsonPointer", EXTERNAL_PATH_MAX_BYTES), role: oneOf(use.role, ["semantic-scene", "occupancy-grid", "environment-model", "environment-splat", "environment-pano", "seat-model", "model-sidecar", "ibl-source", "ibl-project-fallback"] as const, "external role"), declaredPath: boundedString(use.declaredPath, "declaredPath", EXTERNAL_PATH_MAX_BYTES), resolvedPath: absolutePath(use.resolvedPath, "resolvedPath", EXTERNAL_PATH_MAX_BYTES), fileIndex };
  });
  const files = object.files.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail("external file must be an object");
    const status = oneOf((entry as Record<string, unknown>).status, ["absent", "observed"] as const, "external file status");
    if (status === "absent") {
      const file = record(entry, ["status", "resolvedPath"], "absent external file");
      return { status, resolvedPath: absolutePath(file.resolvedPath, "resolvedPath", EXTERNAL_PATH_MAX_BYTES) } as const;
    }
    const file = record(entry, ["status", "resolvedPath", "realPath", "bytes", "sha256", "validation"], "observed external file");
    const validation = oneOf(file.validation, ["semantic-json", "occupancy-json", "self-contained-model", "model-sidecar", "splat", "pano", "ibl-ktx", "invalid"] as const, "external file validation");
    const bytes = integer(file.bytes, "external file bytes");
    const fileMax = validation === "semantic-json" || validation === "occupancy-json" ? 64 * 1024 * 1024
      : validation === "ibl-ktx" ? 256 * 1024 * 1024
        : 512 * 1024 * 1024;
    if (bytes > fileMax) fail("external file byte limit exceeded");
    return { status, resolvedPath: absolutePath(file.resolvedPath, "resolvedPath", EXTERNAL_PATH_MAX_BYTES), realPath: absolutePath(file.realPath, "realPath", EXTERNAL_PATH_MAX_BYTES), bytes, sha256: shaValue(file.sha256, "external file sha256"), validation } as const;
  });
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1]!.resolvedPath >= files[index]!.resolvedPath) fail("external files must be unique and sorted by canonical resolved path");
  }
  const iblChoices = object.iblChoices.map((entry) => {
    const choice = record(entry, ["ktxAssetPath", "resolution", "externalFileIndex"], "ibl choice");
    const resolution = oneOf(choice.resolution, ["external-source", "project-generation", "unresolved"] as const, "ibl resolution");
    const externalFileIndex = choice.externalFileIndex === null ? null : integer(choice.externalFileIndex, "ibl file index");
    if ((resolution === "unresolved") !== (externalFileIndex === null)) fail("ibl choice index does not match resolution");
    if (externalFileIndex !== null && externalFileIndex >= files.length) fail("ibl file index out of range");
    const ktxAssetPath = boundedString(choice.ktxAssetPath, "ktxAssetPath", EXTERNAL_PATH_MAX_BYTES, false);
    if (!isSafeIblAssetPath(ktxAssetPath)) fail("ktxAssetPath must be a safe APK-relative .ktx path");
    return { ktxAssetPath, resolution, externalFileIndex };
  });
  const uniqueFileCount = integer(object.uniqueFileCount, "uniqueFileCount");
  if (uniqueFileCount !== files.length) fail("uniqueFileCount mismatch");
  const totalBytes = integer(object.totalBytes, "totalBytes");
  const observedTotal = files.reduce((sum, file) => sum + (file.status === "observed" ? file.bytes : 0), 0);
  if (!Number.isSafeInteger(observedTotal) || totalBytes !== observedTotal) fail("external input totalBytes mismatch");
  if (totalBytes > EXTERNAL_INPUT_TOTAL_MAX_BYTES) fail("external input aggregate byte limit exceeded");
  return {
    kind: "pico.workflow-external-input", schemaVersion: 1, policy: "pico-fleet-external-input-v1",
    appSpecSha256: shaValue(object.appSpecSha256, "appSpecSha256"), briefPayloadSha256: shaValue(object.briefPayloadSha256, "briefPayloadSha256"),
    resourceKey: shaValue(object.resourceKey, "resourceKey"), projectResourceKey: shaValue(object.projectResourceKey, "projectResourceKey"),
    physicalProjectDir: absolutePath(object.physicalProjectDir, "physicalProjectDir", EXTERNAL_PATH_MAX_BYTES), inputBaseDir: absolutePath(object.inputBaseDir, "inputBaseDir", EXTERNAL_PATH_MAX_BYTES),
    iblSelector, uses, files, iblChoices, uniqueFileCount, totalBytes,
  };
}

export function parseSnapshotEnvelope(kind: SnapshotRefV1["kind"], value: unknown): SnapshotEnvelopeV1 {
  const strictKind = oneOf(kind, ["goal", "acceptance", "app-spec", "brief-payload", "external-input", "compiler-ledger", "public-result"] as const, "snapshot kind");
  const maxBytes = strictKind === "acceptance" ? RUN_ACCEPTANCE_MAX_BYTES
    : strictKind === "app-spec" ? APP_SPEC_SNAPSHOT_MAX_BYTES
      : strictKind === "brief-payload" ? BRIEF_PAYLOAD_SNAPSHOT_MAX_BYTES
        : strictKind === "external-input" ? EXTERNAL_INPUT_SNAPSHOT_MAX_BYTES
          : strictKind === "compiler-ledger" ? COMPILER_LEDGER_MAX_BYTES
            : PUBLIC_RESULT_MAX_BYTES;
  inspectCanonical(value, maxBytes, `${strictKind} snapshot`, strictKind === "brief-payload" ? ORIGINAL_GOAL_MAX_BYTES : STRING_MAX_BYTES);
  kind = strictKind;
  if (kind === "goal") {
    const object = record(value, ["kind", "schemaVersion", "goal"], "goal envelope");
    literal(object.kind, "pico.workflow-goal", "goal kind"); literal(object.schemaVersion, 1, "goal schemaVersion");
    const goal = stringValue(object.goal, "goal", false);
    if (normalizeGoal(goal).normalized !== goal) fail("stored goal must already be normalized");
    return { kind: "pico.workflow-goal", schemaVersion: 1, goal };
  }
  if (kind === "acceptance") {
    const object = record(value, ["kind", "schemaVersion", "criteria"], "acceptance envelope");
    literal(object.kind, "pico.workflow-acceptance", "acceptance kind"); literal(object.schemaVersion, 1, "acceptance schemaVersion");
    if (!Array.isArray(object.criteria) || object.criteria.length < 1 || object.criteria.length > RUN_ACCEPTANCE_MAX) fail("acceptance must contain 1..64 criteria");
    return { kind: "pico.workflow-acceptance", schemaVersion: 1, criteria: object.criteria.map((criterion, index) => strictCriterion(criterion, index, false)) };
  }
  if (kind === "app-spec") {
    const object = record(value, ["kind", "schemaVersion", "spec"], "AppSpec envelope");
    literal(object.kind, "pico.workflow-app-spec", "AppSpec kind"); literal(object.schemaVersion, 1, "AppSpec schemaVersion");
    return { kind: "pico.workflow-app-spec", schemaVersion: 1, spec: appSpecSchema.parse(object.spec) };
  }
  if (kind === "brief-payload") {
    const object = record(value, ["kind", "schemaVersion", "id", "brief", "spec"], "brief payload envelope");
    literal(object.kind, "pico.workflow-brief-payload", "brief payload kind"); literal(object.schemaVersion, 1, "brief payload schemaVersion");
    inspectCanonical(object.spec, APP_SPEC_SNAPSHOT_MAX_BYTES, "brief payload AppSpec");
    return { kind: "pico.workflow-brief-payload", schemaVersion: 1, id: stringValue(object.id, "brief payload id", false), brief: boundedString(object.brief, "brief payload brief", ORIGINAL_GOAL_MAX_BYTES), spec: appSpecSchema.parse(object.spec) };
  }
  if (kind === "external-input") return parseExternalInput(value);
  if (kind === "compiler-ledger") return parseCompilerLedger(value);
  const object = record(value, ["kind", "schemaVersion", "workflow", "status", "publicResult"], "public result envelope");
  literal(object.kind, "pico.workflow-public-result", "public result kind"); literal(object.schemaVersion, 1, "public result schemaVersion");
  const workflow = oneOf(object.workflow, ["pico-build-app", "pico-loop"] as const, "public result workflow");
  const publicResult = parsePublicResult(workflow, object.publicResult);
  if (object.status !== publicResult.status) fail("public result envelope status mismatch");
  return { kind: "pico.workflow-public-result", schemaVersion: 1, workflow, status: oneOf(object.status, PUBLIC_STATUSES, "public result status"), publicResult };
}

const PUBLIC_STATUSES = ["needs-authoring", "plan-failed", "failed", "built-not-installed", "built-no-capture", "auto-judged-needs-look", "built-needs-look", "accepted", "unmeasurable-acceptance", "no-progress", "manual-repair-required", "budget-exhausted"] as const;

function parseOutcome(value: unknown, allowBuild = true): LoopPublicOutcomeV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("loop outcome must be an object");
  const source = value as Record<string, unknown>;
  if (source.kind === "build") {
    if (!allowBuild) fail("build outcome is not a criterion outcome");
    const object = record(value, ["kind", "status", "detail"], "build outcome");
    return { kind: literal(object.kind, "build", "build outcome kind"), status: literal(object.status, "fail", "build outcome status"), detail: stringValue(object.detail, "build outcome detail", false) };
  }
  const object = record(value, ["inputIndex", "criterionDigest", "kind", "status", "detail", "machineVerdict", "recordedEvidence", "failureClass", "machineChecks"], "criterion outcome");
  if (!Array.isArray(object.machineChecks)) fail("machineChecks must be an array");
  const outcome = {
    inputIndex: integer(object.inputIndex, "outcome inputIndex"), criterionDigest: shaValue(object.criterionDigest, "outcome criterionDigest"),
    kind: oneOf(object.kind, ["structural", "visual", "logcat", "perf"] as const, "outcome kind"),
    status: oneOf(object.status, ["pass", "fail", "unmeasurable", "needs-look"] as const, "outcome status"),
    detail: nullableString(object.detail, "outcome detail"), machineVerdict: nullableString(object.machineVerdict, "machineVerdict"),
    recordedEvidence: object.recordedEvidence === null ? null : bool(object.recordedEvidence, "recordedEvidence"),
    failureClass: nullableString(object.failureClass, "failureClass"), machineChecks: object.machineChecks as JsonValue[],
  };
  if (outcome.kind !== "visual" && outcome.recordedEvidence !== null) fail("only visual outcomes may carry recordedEvidence");
  if (outcome.status === "needs-look" && outcome.kind !== "visual") fail("only visual outcomes may need a look");
  if (outcome.recordedEvidence === true && outcome.status !== "pass") fail("recorded visual evidence requires a passing outcome");
  return outcome;
}

function validateOutcomeOrder(outcomes: LoopPublicOutcomeV1[]): void {
  const seen = new Set<string>();
  let lastLogcat = -1;
  let lastOther = -1;
  let sawBuild = false;
  let sawNonLogcat = false;
  let sawCriterion = false;
  for (const outcome of outcomes) {
    if (outcome.kind === "build") {
      if (sawBuild || sawCriterion) fail("build failure outcome must be unique and precede criterion outcomes");
      sawBuild = true;
      continue;
    }
    sawCriterion = true;
    const identity = `${outcome.inputIndex}:${outcome.criterionDigest}`;
    if (seen.has(identity)) fail("duplicate criterion outcome identity");
    seen.add(identity);
    if (outcome.kind === "logcat") {
      if (sawNonLogcat || outcome.inputIndex <= lastLogcat) fail("logcat outcomes must be first and stable by input index");
      lastLogcat = outcome.inputIndex;
    } else {
      sawNonLogcat = true;
      if (outcome.inputIndex <= lastOther) fail("non-logcat outcomes must be stable by input index");
      lastOther = outcome.inputIndex;
    }
  }
}

function parseOutcomeSubset(
  value: unknown,
  label: string,
  finalOutcomes: LoopPublicOutcomeV1[],
  predicate: (outcome: LoopPublicOutcomeV1) => boolean,
): LoopPublicOutcomeV1[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a nonempty outcome array`);
  const outcomes = value.map((outcome) => parseOutcome(outcome));
  validateOutcomeOrder(outcomes);
  if (outcomes.some((outcome) => !predicate(outcome))) fail(`${label} contains an outcome with an invalid status`);
  const expected = finalOutcomes.filter(predicate);
  if (canonicalJson(outcomes) !== canonicalJson(expected)) fail(`${label} must exactly match the stable final-iteration subset`);
  return outcomes;
}

function parseLoopCommon(source: Record<string, unknown>, allowedExtras: string[]): LoopExitCommonV1 {
  const optional = ["capture", "receiptId", "receiptPath", "perfTrend", "perfEvidence"];
  recordOptional(source, ["status", "iterations", "briefId", "projectDir", "scaffoldStarted", "iterationsLog", ...allowedExtras.filter((key) => !["detail"].includes(key))], [...optional, ...(allowedExtras.includes("detail") ? ["detail"] : [])], "loop result");
  const iterations = integer(source.iterations, "loop iterations", 1);
  if (!Array.isArray(source.iterationsLog)) fail("iterationsLog must be an array");
  const iterationsLog = source.iterationsLog.map((entry, index) => {
    const row = record(entry, ["iteration", "outcomes", "capture", "receiptId", "receiptPath", "ledger"], "iteration row");
    const iteration = integer(row.iteration, "iteration row index", 1);
    if (iteration !== index + 1) fail("iteration rows must be positive contiguous");
    if (!Array.isArray(row.outcomes)) fail("iteration outcomes must be an array");
    const outcomes = row.outcomes.map((outcome) => parseOutcome(outcome));
    validateOutcomeOrder(outcomes);
    const receiptId = row.receiptId === null ? null : shaValue(row.receiptId, "iteration receiptId");
    const receiptPath = row.receiptPath === null ? null : absolutePath(row.receiptPath, "iteration receiptPath");
    const capture = row.capture === null ? null : absolutePath(row.capture, "iteration capture");
    if ([receiptId, receiptPath, capture].filter((item) => item !== null).length % 3 !== 0) fail("iteration receipt triple must be all null or all present");
    return { iteration, outcomes, capture, receiptId, receiptPath, ledger: stringValue(row.ledger, "iteration ledger") };
  });
  if (iterations !== iterationsLog.length) fail("loop iterations count must equal iterationsLog length");
  const receiptPresence = ["capture", "receiptId", "receiptPath"].map((key) => Object.hasOwn(source, key));
  if (!receiptPresence.every((present) => present === receiptPresence[0])) fail("loop receipt triple fields must occur together");
  const perfPresence = ["perfTrend", "perfEvidence"].map((key) => Object.hasOwn(source, key));
  if (perfPresence[0] !== perfPresence[1]) fail("loop perf fields must occur together");
  const result: LoopExitCommonV1 = {
    iterations, briefId: stringValue(source.briefId, "briefId", false), projectDir: absolutePath(source.projectDir, "projectDir"),
    scaffoldStarted: bool(source.scaffoldStarted, "scaffoldStarted"), iterationsLog,
  };
  if (receiptPresence[0]) {
    result.capture = source.capture === null ? null : absolutePath(source.capture, "capture");
    result.receiptId = source.receiptId === null ? null : shaValue(source.receiptId, "receiptId");
    result.receiptPath = source.receiptPath === null ? null : absolutePath(source.receiptPath, "receiptPath");
    if ([result.capture, result.receiptId, result.receiptPath].filter((item) => item !== null).length % 3 !== 0) fail("loop receipt triple values must be all null or all present");
  }
  if (perfPresence[0]) {
    if (!Array.isArray(source.perfTrend)) fail("perfTrend must be an array");
    result.perfTrend = source.perfTrend as JsonValue[];
    result.perfEvidence = stringValue(source.perfEvidence, "perfEvidence");
  }
  return result;
}

function parseLookObligations(value: unknown): Array<{ artifact: string | null; whatToConfirm: string }> {
  if (!Array.isArray(value)) fail("remainingLookObligation must be an array");
  return value.map((entry) => {
    const object = record(entry, ["artifact", "whatToConfirm"], "look obligation");
    return { artifact: object.artifact === null ? null : absolutePath(object.artifact, "look artifact"), whatToConfirm: stringValue(object.whatToConfirm, "whatToConfirm") };
  });
}

export function parsePublicResult(workflow: RunWorkflowV1, value: unknown): BuildAppPublicResultV1 | PicoLoopPublicResultV1 {
  workflow = oneOf(workflow, ["pico-build-app", "pico-loop"] as const, "public result workflow");
  inspectCanonical(value, PUBLIC_RESULT_MAX_BYTES, "public result");
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("public result must be an object");
  const source = value as Record<string, unknown>;
  const status = stringValue(source.status, "public result status", false);
  if (workflow === "pico-build-app") {
    if (status === "needs-authoring") {
      const object = recordOptional(value, ["status", "scaffold", "fix"], ["archetype", "archetypeWhy"], "needs-authoring result");
      if (Object.hasOwn(object, "archetype") !== Object.hasOwn(object, "archetypeWhy")) fail("archetype fields must occur together");
      const result: Extract<BuildAppPublicResultV1, { status: "needs-authoring" }> = { status, scaffold: appSpecSchema.parse(object.scaffold), fix: stringValue(object.fix, "fix") };
      if (Object.hasOwn(object, "archetype")) { result.archetype = stringValue(object.archetype, "archetype"); result.archetypeWhy = stringValue(object.archetypeWhy, "archetypeWhy"); }
      return result;
    }
    if (status === "plan-failed") {
      const object = record(value, ["status", "detail", "fix"], "build plan-failed result");
      return { status, detail: object.detail as JsonValue, fix: stringValue(object.fix, "fix") };
    }
    const buildStatus = oneOf(status, ["failed", "built-not-installed", "built-no-capture", "auto-judged-needs-look", "built-needs-look"] as const, "build status");
    const needsFix = ["failed", "built-not-installed", "built-no-capture"].includes(buildStatus);
    const required = ["status", "briefId", "built", "installed", "verdict", "autoJudgedRecorded", "receiptId", "receiptPath", "capture", "notes", "projectDir", "honesty", ...(needsFix ? ["fix"] : [])];
    const object = recordOptional(value, required, ["identity"], "build work result");
    if (!Array.isArray(object.notes)) fail("build notes must be an array");
    const receiptId = object.receiptId === null ? null : shaValue(object.receiptId, "receiptId");
    const receiptPath = object.receiptPath === null ? null : absolutePath(object.receiptPath, "receiptPath");
    const capture = object.capture === null ? null : absolutePath(object.capture, "capture");
    const receiptCount = [receiptId, receiptPath, capture].filter((item) => item !== null).length;
    if (receiptCount !== 0 && receiptCount !== 3) fail("build receipt triple must be all null or all present");
    const built = bool(object.built, "built"); const installed = bool(object.installed, "installed");
    const autoJudgedRecorded = bool(object.autoJudgedRecorded, "autoJudgedRecorded");
    if (buildStatus === "failed" && (built || installed)) fail("failed build booleans are impossible");
    if (buildStatus === "built-not-installed" && (!built || installed)) fail("built-not-installed booleans are impossible");
    if (buildStatus === "built-no-capture" && (!built || !installed || receiptCount !== 0)) fail("built-no-capture fields are impossible");
    if (["auto-judged-needs-look", "built-needs-look"].includes(buildStatus) && (!built || !installed || receiptCount !== 3)) fail("needs-look requires successful build and receipt triple");
    if (autoJudgedRecorded !== (buildStatus === "auto-judged-needs-look")) fail("autoJudgedRecorded does not match status");
    const common: BuildWorkCommonV1 = {
      briefId: stringValue(object.briefId, "briefId", false), built, installed,
      verdict: nullableString(object.verdict, "verdict"), autoJudgedRecorded, receiptId, receiptPath, capture,
      notes: object.notes.map((note) => stringValue(note, "note")), projectDir: absolutePath(object.projectDir, "projectDir"),
      honesty: stringValue(object.honesty, "honesty"),
    };
    if (Object.hasOwn(object, "identity")) common.identity = stringValue(object.identity, "identity");
    return needsFix ? { ...common, status: buildStatus as "failed" | "built-not-installed" | "built-no-capture", fix: stringValue(object.fix, "fix") } : { ...common, status: buildStatus as "auto-judged-needs-look" | "built-needs-look" };
  }
  if (status === "plan-failed" && source.iterations === 0) {
    const object = record(value, ["status", "iterations", "detail", "fix"], "pre-run loop plan-failed result");
    return { status, iterations: literal(object.iterations, 0, "iterations"), detail: object.detail as JsonValue, fix: stringValue(object.fix, "fix") };
  }
  const statusExtras: Record<string, string[]> = {
    "plan-failed": ["detail", "fix"], "budget-exhausted": ["failing", "fix"], accepted: ["ceiling", "acceptanceScope", "fleetVisualVerdict", "remainingLookObligation", "honesty"],
    "built-needs-look": ["needsLook", "remainingLookObligation", "honesty"], "unmeasurable-acceptance": ["failing", "fix"],
    "no-progress": ["failing", "fix", "detail"], failed: ["failing", "fix"], "manual-repair-required": ["failing", "fix", "detail"],
  };
  if (!Object.hasOwn(statusExtras, status)) fail("status is not valid for pico-loop");
  if (status === "plan-failed" && !Object.hasOwn(source, "detail")) fail("plan-failed detail is required");
  const common = parseLoopCommon(source, statusExtras[status]!);
  const finalOutcomes = common.iterationsLog.at(-1)!.outcomes;
  if (status === "accepted") return { ...common, status, ceiling: oneOf(source.ceiling, ["structural", "auto_judged"] as const, "acceptance ceiling"), acceptanceScope: stringValue(source.acceptanceScope, "acceptanceScope"), fleetVisualVerdict: stringValue(source.fleetVisualVerdict, "fleetVisualVerdict"), remainingLookObligation: parseLookObligations(source.remainingLookObligation), honesty: stringValue(source.honesty, "honesty") };
  if (status === "built-needs-look") {
    const needsLook = parseOutcomeSubset(source.needsLook, "needsLook", finalOutcomes, (outcome) => outcome.kind !== "build" && outcome.kind === "visual" && outcome.status === "needs-look");
    return { ...common, status, needsLook, remainingLookObligation: parseLookObligations(source.remainingLookObligation), honesty: stringValue(source.honesty, "honesty") };
  }
  if (status === "plan-failed") return { ...common, status, detail: source.detail as JsonValue, fix: stringValue(source.fix, "fix") };
  const failingPredicate = status === "budget-exhausted"
    ? (outcome: LoopPublicOutcomeV1) => outcome.status !== "pass"
    : status === "unmeasurable-acceptance"
      ? (outcome: LoopPublicOutcomeV1) => outcome.status === "fail" || outcome.status === "unmeasurable"
      : (outcome: LoopPublicOutcomeV1) => outcome.status === "fail";
  const failing = parseOutcomeSubset(source.failing, "failing", finalOutcomes, failingPredicate);
  if (status === "unmeasurable-acceptance" && !failing.some((outcome) => outcome.kind !== "build" && outcome.status === "unmeasurable")) fail("unmeasurable-acceptance requires an unmeasurable criterion");
  const fix = stringValue(source.fix, "fix");
  if (status === "no-progress" || status === "manual-repair-required") {
    return Object.hasOwn(source, "detail") ? { ...common, status, failing, detail: source.detail as JsonValue, fix } : { ...common, status, failing, fix };
  }
  return { ...common, status: status as "budget-exhausted" | "unmeasurable-acceptance" | "failed", failing, fix };
}

function parseGeneration(value: unknown): TargetGenerationV1 {
  const object = record(value, ["brief", "project"], "target generation");
  if (object.brief === null || typeof object.brief !== "object" || Array.isArray(object.brief)) fail("brief generation must be an object");
  const briefStatus = oneOf((object.brief as Record<string, unknown>).status, ["absent", "observed"] as const, "brief generation status");
  let brief: BriefGenerationV1;
  if (briefStatus === "absent") { record(object.brief, ["status"], "absent brief generation"); brief = { status: "absent" }; }
  else {
    const observed = record(object.brief, ["status", "bytes", "sha256"], "observed brief generation");
    brief = { status: "observed", bytes: integer(observed.bytes, "brief generation bytes"), sha256: shaValue(observed.sha256, "brief generation sha256") };
  }
  if (object.project === null || typeof object.project !== "object" || Array.isArray(object.project)) fail("project generation must be an object");
  const projectStatus = oneOf((object.project as Record<string, unknown>).status, ["absent", "observed", "unobservable"] as const, "project generation status");
  let project: ProjectInputGenerationV1;
  if (projectStatus === "absent") { record(object.project, ["status"], "absent project generation"); project = { status: "absent" }; }
  else if (projectStatus === "unobservable") {
    const unobservable = record(object.project, ["status", "reason", "reasonSha256"], "unobservable project generation");
    const reason = stringValue(unobservable.reason, "project generation reason");
    if (shaValue(unobservable.reasonSha256, "reasonSha256") !== sha256(reason)) fail("project generation reason digest mismatch");
    project = { status: "unobservable", reason, reasonSha256: sha256(reason) };
  } else {
    const observed = record(object.project, ["status", "directory", "identity"], "observed project generation");
    const directory = record(observed.directory, ["physicalPath", "device", "inode"], "generation directory");
    const identity = record(observed.identity, ["kind", "schemaVersion", "policy", "projectDir", "algorithm", "sha256", "entryCount", "totalBytes"], "Gradle input identity");
    project = { status: "observed", directory: {
      physicalPath: absolutePath(directory.physicalPath, "generation physicalPath"), device: stringValue(directory.device, "generation device", false), inode: stringValue(directory.inode, "generation inode", false),
    }, identity: {
      kind: literal(identity.kind, "pico.gradle-input-generation", "generation identity kind"), schemaVersion: literal(identity.schemaVersion, 1, "generation identity schemaVersion"),
      policy: literal(identity.policy, "pico-native-receipt-gradle-input-v1", "generation policy"), projectDir: absolutePath(identity.projectDir, "generation projectDir"),
      algorithm: literal(identity.algorithm, "sha256", "generation algorithm"), sha256: shaValue(identity.sha256, "generation sha256"), entryCount: integer(identity.entryCount, "generation entryCount"), totalBytes: integer(identity.totalBytes, "generation totalBytes"),
    } };
    if (project.directory.physicalPath !== project.identity.projectDir) fail("project generation paths mismatch");
  }
  return { brief, project };
}

function parseProjectGenerationState(value: unknown): ProjectGenerationStateV1 {
  const object = record(value, ["expected", "lastAttempt"], "project generation state");
  const expected = parseGeneration(object.expected);
  if (object.lastAttempt === null) return { expected, lastAttempt: null };
  const attempt = record(object.lastAttempt, ["attemptId", "before", "after", "attribution"], "last attempt generation");
  let attribution: NonNullable<ProjectGenerationStateV1["lastAttempt"]>["attribution"] = null;
  if (attempt.attribution !== null) {
    const item = record(attempt.attribution, ["status", "compilerLedger", "receiptId"], "generation attribution");
    const status = oneOf(item.status, ["unchanged", "fleet-write-set", "receipt-and-fleet-write-set"] as const, "attribution status");
    const compilerLedger = item.compilerLedger === null ? null : shaValue(item.compilerLedger, "attribution compilerLedger");
    const receiptId = item.receiptId === null ? null : shaValue(item.receiptId, "attribution receiptId");
    if (status === "unchanged" && (compilerLedger !== null || receiptId !== null)) fail("unchanged attribution cannot cite writes or receipt");
    if (status === "fleet-write-set" && (compilerLedger === null || receiptId !== null)) fail("fleet-write-set attribution fields mismatch");
    if (status === "receipt-and-fleet-write-set" && (compilerLedger === null || receiptId === null)) fail("receipt attribution fields mismatch");
    attribution = { status, compilerLedger, receiptId };
  }
  const after = attempt.after === null ? null : parseGeneration(attempt.after);
  if (attribution !== null && after === null) fail("attributed attempt requires an after generation");
  return { expected, lastAttempt: { attemptId: uuidValue(attempt.attemptId, "attemptId"), before: parseGeneration(attempt.before), after, attribution } };
}

function parseCompilerOutcome(value: unknown): CompilerOutcomeV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("compiler outcome must be an object");
  const status = oneOf((value as Record<string, unknown>).status, ["not-run", "succeeded", "failed", "in-doubt"] as const, "compiler status");
  if (status === "not-run") { record(value, ["status"], "not-run compiler"); return { status }; }
  if (status === "succeeded") {
    const object = record(value, ["status", "ledger", "plannedCount", "completedCount", "elapsedMs", "executionDisposition"], "succeeded compiler");
    const plannedCount = integer(object.plannedCount, "plannedCount"); const completedCount = integer(object.completedCount, "completedCount");
    if (completedCount > plannedCount) fail("completedCount exceeds plannedCount");
    return { status, ledger: parseSnapshotRef(object.ledger, "compiler-ledger") as SnapshotRefV1 & { kind: "compiler-ledger" }, plannedCount, completedCount, elapsedMs: integer(object.elapsedMs, "elapsedMs"), executionDisposition: literal(object.executionDisposition, "definitely-completed", "compiler disposition") };
  }
  if (status === "failed") {
    const object = record(value, ["status", "ledger", "phase", "failure", "plannedCount", "completedCount", "elapsedMs", "executionDisposition"], "failed compiler");
    const plannedCount = integer(object.plannedCount, "plannedCount"); const completedCount = integer(object.completedCount, "completedCount");
    if (completedCount > plannedCount) fail("completedCount exceeds plannedCount");
    return { status, ledger: object.ledger === null ? null : parseSnapshotRef(object.ledger, "compiler-ledger") as SnapshotRefV1 & { kind: "compiler-ledger" }, phase: oneOf(object.phase, ["fleet-build", "scaffold", "compiler", "generator", "asset-delivery", "native-build"] as const, "compiler phase"), failure: parseDiagnostic(object.failure, "compiler failure"), plannedCount, completedCount, elapsedMs: integer(object.elapsedMs, "elapsedMs"), executionDisposition: literal(object.executionDisposition, "definitely-completed", "compiler disposition") };
  }
  const object = record(value, ["status", "ledger", "phase", "reason", "plannedCount", "completedCount", "elapsedMs", "executionDisposition"], "in-doubt compiler");
  const plannedCount = object.plannedCount === null ? null : integer(object.plannedCount, "plannedCount");
  const completedCount = object.completedCount === null ? null : integer(object.completedCount, "completedCount");
  const elapsedMs = object.elapsedMs === null ? null : integer(object.elapsedMs, "elapsedMs");
  const nullableCount = [plannedCount, completedCount, elapsedMs].filter((item) => item === null).length;
  if (nullableCount !== 0 && nullableCount !== 3) fail("in-doubt compiler count/timing fields must be all known or all null");
  if (plannedCount !== null && completedCount! > plannedCount) fail("completedCount exceeds plannedCount");
  return { status, ledger: object.ledger === null ? null : parseSnapshotRef(object.ledger, "compiler-ledger") as SnapshotRefV1 & { kind: "compiler-ledger" }, phase: oneOf(object.phase, ["fleet-build", "scaffold", "compiler", "generator", "asset-delivery", "native-build"] as const, "compiler phase"), reason: parseDiagnostic(object.reason, "compiler in-doubt reason"), plannedCount, completedCount, elapsedMs, executionDisposition: literal(object.executionDisposition, "in-doubt", "compiler disposition") };
}

function parseStructuralLedger(value: unknown): StructuralLedgerResultV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("structural ledger result must be an object");
  const status = oneOf((value as Record<string, unknown>).status, ["recorded", "not-recorded"] as const, "structural ledger status");
  if (status === "recorded") { const object = record(value, ["status", "seq"], "recorded structural ledger"); return { status, seq: integer(object.seq, "structural ledger seq") }; }
  const object = record(value, ["status", "reason"], "not-recorded structural ledger");
  return { status, reason: parseDiagnostic(object.reason, "structural ledger reason") };
}

function parseIteration(value: unknown): IterationStateV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("iteration state must be an object");
  const status = oneOf((value as Record<string, unknown>).status, ["not-run", "blocked", "completed"] as const, "iteration status");
  if (status === "not-run") {
    const object = record(value, ["status", "nextIndex", "completedCount", "previousFailureSignature"], "not-run iteration");
    if (object.previousFailureSignature !== null) fail("not-run previousFailureSignature must be null");
    return { status, nextIndex: literal(object.nextIndex, 1, "nextIndex"), completedCount: literal(object.completedCount, 0, "completedCount"), previousFailureSignature: null };
  }
  if (status === "blocked") {
    const object = record(value, ["status", "index", "completedCount", "nextIndex", "failure", "previousFailureSignature", "structuralLedger"], "blocked iteration");
    const index = integer(object.index, "iteration index", 1); const completedCount = integer(object.completedCount, "completedCount"); const nextIndex = integer(object.nextIndex, "nextIndex", 1);
    if (completedCount !== index || nextIndex !== index + 1) fail("blocked iteration counters mismatch");
    return { status, index, completedCount, nextIndex, failure: parseDiagnostic(object.failure, "iteration failure"), previousFailureSignature: nullableString(object.previousFailureSignature, "previousFailureSignature"), structuralLedger: parseStructuralLedger(object.structuralLedger) };
  }
  const object = record(value, ["status", "index", "completedCount", "nextIndex", "outcomes", "previousFailureSignature", "perfSamples", "structuralLedger"], "completed iteration");
  const index = integer(object.index, "iteration index", 1); const completedCount = integer(object.completedCount, "completedCount"); const nextIndex = integer(object.nextIndex, "nextIndex", 1);
  if (completedCount !== index || nextIndex !== index + 1) fail("completed iteration counters mismatch");
  if (!Array.isArray(object.outcomes) || !Array.isArray(object.perfSamples)) fail("iteration outcomes/perfSamples must be arrays");
  const outcomes = object.outcomes.map((outcome) => parseOutcome(outcome, false) as CriterionOutcomeV1);
  validateOutcomeOrder(outcomes);
  const perfSamples = object.perfSamples.map((entry) => {
    const sample = record(entry, ["inputIndex", "criterionDigest", "measurement"], "perf sample");
    const measurement = record(sample.measurement, ["iteration", "p5", "p10", "p50", "avg", "jankWindows", "reportPath"], "perf measurement");
    if (integer(measurement.iteration, "perf iteration", 1) !== index) fail("perf sample iteration mismatch");
    return { inputIndex: integer(sample.inputIndex, "perf inputIndex"), criterionDigest: shaValue(sample.criterionDigest, "perf criterionDigest"), measurement: { iteration: index, p5: finite(measurement.p5, "p5"), p10: optionalNullableNumber(measurement.p10, "p10"), p50: optionalNullableNumber(measurement.p50, "p50"), avg: finite(measurement.avg, "avg"), jankWindows: measurement.jankWindows === null ? null : integer(measurement.jankWindows, "jankWindows"), reportPath: measurement.reportPath === null ? null : absolutePath(measurement.reportPath, "reportPath") } };
  });
  for (const sample of perfSamples) {
    if (!outcomes.some((outcome) => outcome.kind === "perf" && outcome.inputIndex === sample.inputIndex && outcome.criterionDigest === sample.criterionDigest)) fail("perf sample has no matching perf outcome");
  }
  return { status, index, completedCount, nextIndex, outcomes, previousFailureSignature: nullableString(object.previousFailureSignature, "previousFailureSignature"), perfSamples, structuralLedger: parseStructuralLedger(object.structuralLedger) };
}

const PAUSED_STATUSES = ["plan-failed", "failed", "built-not-installed", "built-no-capture", "unmeasurable-acceptance", "no-progress", "manual-repair-required"] as const;
const TERMINAL_STATUSES = ["built-needs-look", "auto-judged-needs-look", "accepted", "budget-exhausted", "failed"] as const;
const EXTERNAL_PHASES = ["fleet-build", "scaffold", "compiler", "generator", "native-build", "install", "asset-delivery", "launch", "capture", "receipt-publication", "visual-judge", "mouse-bridge", "panel-launch", "panel-probe", "panel-capture", "acceptance-logcat", "acceptance-structural", "acceptance-perf", "structural-ledger", "replan"] as const;

function parseLifecycle(value: unknown): LifecycleV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("lifecycle must be an object");
  const status = oneOf((value as Record<string, unknown>).status, ["open", "running", "paused", "blocked", "terminal"] as const, "lifecycle status");
  if (status === "open") {
    const object = record(value, ["status", "phase", "publicStatus"], "open lifecycle");
    const phase = oneOf(object.phase, ["ready-to-plan", "awaiting-authoring", "ready-to-build"] as const, "open lifecycle phase");
    const publicStatus = object.publicStatus === null ? null : literal(object.publicStatus, "needs-authoring", "open publicStatus");
    if ((phase === "awaiting-authoring") !== (publicStatus === "needs-authoring")) fail("open lifecycle public status mismatch");
    return { status, phase, publicStatus };
  }
  if (status === "running") { const object = record(value, ["status", "phase", "attemptId"], "running lifecycle"); return { status, phase: oneOf(object.phase, ["attempt-started", "attempt-in-doubt"] as const, "running phase"), attemptId: uuidValue(object.attemptId, "running attemptId") }; }
  if (status === "paused") { const object = record(value, ["status", "publicStatus"], "paused lifecycle"); return { status, publicStatus: oneOf(object.publicStatus, PAUSED_STATUSES, "paused publicStatus") }; }
  if (status === "blocked") { const object = record(value, ["status", "reason", "attemptId"], "blocked lifecycle"); return { status, reason: literal(object.reason, "external-state-conflict", "blocked reason"), attemptId: uuidValue(object.attemptId, "blocked attemptId") }; }
  const object = record(value, ["status", "publicStatus"], "terminal lifecycle");
  return { status, publicStatus: oneOf(object.publicStatus, TERMINAL_STATUSES, "terminal publicStatus") };
}

function parseTransition(value: unknown): TransitionV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("transition must be an object");
  const source = value as Record<string, unknown>; const type = stringValue(source.type, "transition type", false);
  if (type === "created") { record(value, ["type"], "created transition"); return { type }; }
  if (type === "plan-completed") {
    const object = record(value, ["type", "outcome", "diagnostic"], "plan-completed transition");
    const outcome = oneOf(object.outcome, ["awaiting-authoring", "ready-to-build", "plan-failed"] as const, "plan outcome");
    const diagnostic = object.diagnostic === null ? null : parseDiagnostic(object.diagnostic, "plan diagnostic");
    if ((outcome === "plan-failed") !== (diagnostic !== null)) fail("plan outcome diagnostic mismatch");
    return { type, outcome, diagnostic };
  }
  if (type === "spec-authored") { const object = record(value, ["type", "previousSpec", "currentSpec"], "spec-authored transition"); return { type, previousSpec: shaValue(object.previousSpec, "previousSpec"), currentSpec: shaValue(object.currentSpec, "currentSpec") }; }
  if (type === "spec-amended") { const object = record(value, ["type", "previousSpec", "currentSpec"], "spec-amended transition"); return { type, previousSpec: object.previousSpec === null ? null : shaValue(object.previousSpec, "previousSpec"), currentSpec: shaValue(object.currentSpec, "currentSpec") }; }
  if (type === "attempt-started") {
    const object = record(value, ["type", "attemptId", "phase", "iteration", "generation", "inputs"], "attempt-started transition");
    const phase = oneOf(object.phase, ["build", "loop-iteration"] as const, "attempt phase");
    const iteration = object.iteration === null ? null : integer(object.iteration, "attempt iteration", 1);
    if ((phase === "build") !== (iteration === null)) fail("attempt phase/iteration mismatch");
    return { type, attemptId: uuidValue(object.attemptId, "attemptId"), phase, iteration, generation: parseGeneration(object.generation), inputs: shaValue(object.inputs, "attempt inputs") };
  }
  if (type === "attempt-in-doubt") { const object = record(value, ["type", "attemptId", "phase", "reason", "externalMutationDisposition"], "attempt-in-doubt transition"); return { type, attemptId: uuidValue(object.attemptId, "attemptId"), phase: oneOf(object.phase, EXTERNAL_PHASES, "external phase"), reason: parseDiagnostic(object.reason, "in-doubt reason"), externalMutationDisposition: oneOf(object.externalMutationDisposition, ["possible", "confirmed"] as const, "external mutation disposition") }; }
  if (type === "attempt-paused") { const object = record(value, ["type", "attemptId", "phase", "publicStatus", "failure", "externalMutationDisposition"], "attempt-paused transition"); return { type, attemptId: uuidValue(object.attemptId, "attemptId"), phase: oneOf(object.phase, EXTERNAL_PHASES, "external phase"), publicStatus: oneOf(object.publicStatus, PAUSED_STATUSES, "paused publicStatus"), failure: parseDiagnostic(object.failure, "attempt failure"), externalMutationDisposition: oneOf(object.externalMutationDisposition, ["none", "possible", "confirmed"] as const, "external mutation disposition") }; }
  if (type === "attempt-conflicted") { const object = record(value, ["type", "attemptId", "reason", "observed", "externalMutationDisposition"], "attempt-conflicted transition"); return { type, attemptId: uuidValue(object.attemptId, "attemptId"), reason: parseDiagnostic(object.reason, "conflict reason"), observed: parseGeneration(object.observed), externalMutationDisposition: oneOf(object.externalMutationDisposition, ["none", "possible", "confirmed"] as const, "external mutation disposition") }; }
  if (type === "iteration-completed") { const object = record(value, ["type", "attemptId", "iteration", "next", "externalMutationDisposition"], "iteration-completed transition"); return { type, attemptId: uuidValue(object.attemptId, "attemptId"), iteration: integer(object.iteration, "iteration", 1), next: literal(object.next, "ready-to-build", "next"), externalMutationDisposition: oneOf(object.externalMutationDisposition, ["none", "possible", "confirmed"] as const, "external mutation disposition") }; }
  if (type === "run-terminal") { const object = record(value, ["type", "attemptId", "publicStatus", "externalMutationDisposition"], "run-terminal transition"); return { type, attemptId: uuidValue(object.attemptId, "attemptId"), publicStatus: oneOf(object.publicStatus, TERMINAL_STATUSES, "terminal publicStatus"), externalMutationDisposition: oneOf(object.externalMutationDisposition, ["none", "possible", "confirmed"] as const, "external mutation disposition") }; }
  if (type === "policy-terminal") { const object = record(value, ["type", "reason", "publicStatus"], "policy-terminal transition"); return { type, reason: oneOf(object.reason, ["time-budget-exhausted", "iteration-budget-exhausted"] as const, "policy terminal reason"), publicStatus: literal(object.publicStatus, "budget-exhausted", "policy terminal publicStatus") }; }
  fail("transition type is invalid");
}

function transitionMatchesLifecycle(transition: TransitionV1, lifecycle: LifecycleV1): boolean {
  if (["created", "spec-authored", "spec-amended"].includes(transition.type)) return lifecycle.status === "open" && lifecycle.phase === "ready-to-plan";
  if (transition.type === "plan-completed") {
    if (transition.outcome === "awaiting-authoring") return lifecycle.status === "open" && lifecycle.phase === "awaiting-authoring";
    if (transition.outcome === "ready-to-build") return lifecycle.status === "open" && lifecycle.phase === "ready-to-build";
    return lifecycle.status === "paused" && lifecycle.publicStatus === "plan-failed";
  }
  if (transition.type === "attempt-started") return lifecycle.status === "running" && lifecycle.phase === "attempt-started" && lifecycle.attemptId === transition.attemptId;
  if (transition.type === "attempt-in-doubt") return lifecycle.status === "running" && lifecycle.phase === "attempt-in-doubt" && lifecycle.attemptId === transition.attemptId;
  if (transition.type === "attempt-paused") return lifecycle.status === "paused" && lifecycle.publicStatus === transition.publicStatus;
  if (transition.type === "attempt-conflicted") return lifecycle.status === "blocked" && lifecycle.attemptId === transition.attemptId;
  if (transition.type === "iteration-completed") return lifecycle.status === "open" && lifecycle.phase === "ready-to-build";
  if (transition.type === "run-terminal") return lifecycle.status === "terminal" && lifecycle.publicStatus === transition.publicStatus;
  return lifecycle.status === "terminal" && lifecycle.publicStatus === "budget-exhausted";
}

function parseLocator(value: unknown): ProjectLocatorV1 {
  const object = record(value, ["kind", "schemaVersion", "requestedProjectsRoot", "physicalProjectsRoot", "requestedProjectDir", "physicalProjectDir", "anchor", "missingSuffix"], "project locator");
  const anchor = record(object.anchor, ["requestedPath", "physicalPath", "device", "inode"], "project locator anchor");
  if (!Array.isArray(object.missingSuffix) || object.missingSuffix.length > LOCATOR_MAX_COMPONENTS) fail("locator missingSuffix component limit exceeded");
  const missingSuffix = object.missingSuffix.map((part) => {
    const segment = boundedString(part, "locator missing suffix", EXTERNAL_PATH_MAX_BYTES, false);
    if (segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) fail("locator missing suffix is unsafe");
    return segment;
  });
  const requestedProjectsRoot = absolutePath(object.requestedProjectsRoot, "requestedProjectsRoot", EXTERNAL_PATH_MAX_BYTES);
  const physicalProjectsRoot = absolutePath(object.physicalProjectsRoot, "physicalProjectsRoot", EXTERNAL_PATH_MAX_BYTES);
  const requestedProjectDir = absolutePath(object.requestedProjectDir, "requestedProjectDir", EXTERNAL_PATH_MAX_BYTES);
  const physicalProjectDir = absolutePath(object.physicalProjectDir, "physicalProjectDir", EXTERNAL_PATH_MAX_BYTES);
  for (const locatorPath of [requestedProjectsRoot, physicalProjectsRoot, requestedProjectDir, physicalProjectDir]) {
    if (locatorPath.split(path.sep).filter(Boolean).length > LOCATOR_MAX_COMPONENTS) fail("locator path component limit exceeded");
  }
  if (requestedProjectDir !== requestedProjectsRoot && !requestedProjectDir.startsWith(`${requestedProjectsRoot}${path.sep}`)) fail("requested project escapes requested root");
  if (physicalProjectDir !== physicalProjectsRoot && !physicalProjectDir.startsWith(`${physicalProjectsRoot}${path.sep}`)) fail("physical project escapes physical root");
  return {
    kind: literal(object.kind, "pico.project-locator", "locator kind"), schemaVersion: literal(object.schemaVersion, 1, "locator schemaVersion"),
    requestedProjectsRoot, physicalProjectsRoot, requestedProjectDir, physicalProjectDir,
    anchor: { requestedPath: absolutePath(anchor.requestedPath, "anchor requestedPath", EXTERNAL_PATH_MAX_BYTES), physicalPath: absolutePath(anchor.physicalPath, "anchor physicalPath", EXTERNAL_PATH_MAX_BYTES), device: stringValue(anchor.device, "anchor device", false), inode: stringValue(anchor.inode, "anchor inode", false) },
    missingSuffix,
  };
}

function briefIdOf(value: string): string {
  return `door${[...value].reduce((accumulator, character) => (accumulator * 31 + character.charCodeAt(0)) % 1_000_003, 7)}`;
}

function parseReceiptRef(value: unknown): NativeReceiptRefV1 {
  const object = record(value, ["kind", "schemaVersion", "app", "receiptId", "captureSha256"], "receipt reference");
  return { kind: literal(object.kind, "pico.native-run-receipt", "receipt kind"), schemaVersion: literal(object.schemaVersion, 1, "receipt schemaVersion"), app: stringValue(object.app, "receipt app", false), receiptId: shaValue(object.receiptId, "receiptId"), captureSha256: shaValue(object.captureSha256, "captureSha256") };
}

function parseAutoJudgeRef(value: unknown): AutoJudgeEventRefV1 {
  const object = record(value, ["kind", "schemaVersion", "app", "seq", "eventDigest", "receiptId", "captureSha256"], "auto-judge reference");
  return { kind: literal(object.kind, "pico.auto-judge-ledger-event", "auto-judge kind"), schemaVersion: literal(object.schemaVersion, 1, "auto-judge schemaVersion"), app: stringValue(object.app, "auto-judge app", false), seq: integer(object.seq, "auto-judge seq"), eventDigest: shaValue(object.eventDigest, "eventDigest"), receiptId: shaValue(object.receiptId, "auto-judge receiptId"), captureSha256: shaValue(object.captureSha256, "auto-judge captureSha256") };
}

export function parseRunRevision(value: unknown): RunRevisionV1 {
  inspectCanonical(value, RUN_REVISION_MAX_BYTES, "run revision", ORIGINAL_GOAL_MAX_BYTES);
  const object = record(value, ["kind", "schemaVersion", "runId", "revision", "revisionId", "parent", "createdAt", "workflow", "intent", "target", "transition", "projectGeneration", "attemptInputs", "compiler", "receiptReferences", "autoJudgeEvidence", "iteration", "publicResult", "lifecycle", "storedEvidenceCeiling"], "run revision");
  literal(object.kind, "pico.workflow-run-revision", "revision kind"); literal(object.schemaVersion, 1, "revision schemaVersion");
  const runId = uuidValue(object.runId, "runId"); const revision = integer(object.revision, "revision", 0, RUN_REVISION_MAX - 1);
  let parent: RunRevisionV1["parent"] = null;
  if (object.parent !== null) {
    const parentObject = record(object.parent, ["revision", "revisionId"], "revision parent");
    parent = { revision: integer(parentObject.revision, "parent revision", 0, RUN_REVISION_MAX - 1), revisionId: shaValue(parentObject.revisionId, "parent revisionId") };
  }
  if ((revision === 0) !== (parent === null)) fail("revision parent presence mismatch");
  if (parent !== null && parent.revision !== revision - 1) fail("revision parent number mismatch");
  const workflow = oneOf(object.workflow, ["pico-build-app", "pico-loop"] as const, "workflow");
  const intentObject = record(object.intent, ["goal", "acceptance", "initialSpec", "currentSpec", "briefPayload", "budget", "onFail", "execution"], "run intent");
  const goal = parseSnapshotRef(intentObject.goal, "goal") as SnapshotRefV1 & { kind: "goal" };
  const acceptance = intentObject.acceptance === null ? null : parseSnapshotRef(intentObject.acceptance, "acceptance") as SnapshotRefV1 & { kind: "acceptance" };
  const initialSpec = intentObject.initialSpec === null ? null : parseSnapshotRef(intentObject.initialSpec, "app-spec") as SnapshotRefV1 & { kind: "app-spec" };
  let currentSpec: RunRevisionV1["intent"]["currentSpec"] = null;
  if (intentObject.currentSpec !== null) {
    const current = record(intentObject.currentSpec, ["snapshot", "origin", "amendsRevision"], "current spec");
    const amendsRevision = current.amendsRevision === null ? null : integer(current.amendsRevision, "amendsRevision", 0, Math.max(0, revision - 1));
    currentSpec = { snapshot: parseSnapshotRef(current.snapshot, "app-spec") as SnapshotRefV1 & { kind: "app-spec" }, origin: oneOf(current.origin, ["planner-scaffold", "caller-authored", "retained-lesson-repair", "explicit-amendment"] as const, "current spec origin"), amendsRevision };
    if ((currentSpec.origin === "explicit-amendment") !== (amendsRevision !== null)) fail("current spec amendment metadata mismatch");
  }
  const briefPayload = intentObject.briefPayload === null ? null : parseSnapshotRef(intentObject.briefPayload, "brief-payload") as SnapshotRefV1 & { kind: "brief-payload" };
  let budget: RunRevisionV1["intent"]["budget"] = null;
  if (intentObject.budget !== null) {
    const budgetObject = record(intentObject.budget, ["iterations", "timeMin", "toolCalls"], "stored budget");
    budget = { iterations: integer(budgetObject.iterations, "budget iterations", 1, 6), timeMin: finite(budgetObject.timeMin, "budget timeMin", 0, 1440), toolCalls: literal(budgetObject.toolCalls, "inert", "budget toolCalls") };
  }
  const onFail = intentObject.onFail === null ? null : oneOf(intentObject.onFail, ["replan", "stop"] as const, "onFail");
  const execution = record(intentObject.execution, ["fleetSettleSec"], "execution policy"); literal(execution.fleetSettleSec, 16, "fleetSettleSec");
  if (workflow === "pico-build-app" && (acceptance !== null || budget !== null || onFail !== null)) fail("build workflow intent contains loop policy");
  if (workflow === "pico-loop" && (acceptance === null || budget === null || onFail === null)) fail("loop workflow requires acceptance and policy");

  const targetObject = record(object.target, ["briefInput", "briefId", "app", "executionSerial", "inputBaseDir", "briefPath", "projectDir", "projectLocator", "resourceKey", "projectResourceKey", "base"], "run target");
  const briefInput = boundedString(targetObject.briefInput, "briefInput", ORIGINAL_GOAL_MAX_BYTES, false); const briefId = stringValue(targetObject.briefId, "briefId", false);
  if (briefId !== briefIdOf(briefInput)) fail("target briefId mismatch");
  const app = stringValue(targetObject.app, "target app", false); if (app !== `com.fleet.${briefId}`) fail("target app mismatch");
  literal(targetObject.executionSerial, "emulator-5554", "executionSerial");
  const inputBaseDir = absolutePath(targetObject.inputBaseDir, "inputBaseDir", EXTERNAL_PATH_MAX_BYTES); const briefPath = absolutePath(targetObject.briefPath, "briefPath", EXTERNAL_PATH_MAX_BYTES); const projectDir = absolutePath(targetObject.projectDir, "projectDir", EXTERNAL_PATH_MAX_BYTES);
  const projectLocator = parseLocator(targetObject.projectLocator);
  if (projectDir !== projectLocator.requestedProjectDir || inputBaseDir !== projectLocator.requestedProjectsRoot) fail("target locator mismatch");
  if (path.basename(briefPath) !== `${briefId}.json` || path.basename(projectDir) !== `fleet-${briefId}-native`) fail("target paths do not name the exact brief ID mapping");
  const resourceKey = shaValue(targetObject.resourceKey, "resourceKey"); const expectedResourceKey = sha256(canonicalJson({ kind: "pico.application-resource", schemaVersion: 1, app, serial: "emulator-5554" }));
  if (resourceKey !== expectedResourceKey) fail("application resource key mismatch");
  const projectResourceKey = shaValue(targetObject.projectResourceKey, "projectResourceKey"); const expectedProjectResourceKey = sha256(canonicalJson({ kind: "pico.physical-project-resource", schemaVersion: 1, physicalProjectDir: projectLocator.physicalProjectDir }));
  if (projectResourceKey !== expectedProjectResourceKey) fail("project resource key mismatch");
  let base: RunRevisionV1["target"]["base"] = null;
  if (targetObject.base !== null) { const baseObject = record(targetObject.base, ["runId", "revision", "revisionId"], "target base"); base = { runId: uuidValue(baseObject.runId, "base runId"), revision: integer(baseObject.revision, "base revision", 0, RUN_REVISION_MAX - 1), revisionId: shaValue(baseObject.revisionId, "base revisionId") }; }

  const transition = parseTransition(object.transition); const lifecycle = parseLifecycle(object.lifecycle);
  if (!transitionMatchesLifecycle(transition, lifecycle)) fail("transition/lifecycle mismatch");
  const projectGeneration = parseProjectGenerationState(object.projectGeneration);
  const attemptInputs = object.attemptInputs === null ? null : parseSnapshotRef(object.attemptInputs, "external-input") as SnapshotRefV1 & { kind: "external-input" };
  const compiler = parseCompilerOutcome(object.compiler); const iteration = parseIteration(object.iteration);
  if (!Array.isArray(object.receiptReferences) || object.receiptReferences.length > 6) fail("receipt references limit exceeded");
  const receiptReferences = object.receiptReferences.map(parseReceiptRef); const receiptIds = new Set<string>();
  for (const receipt of receiptReferences) { if (receipt.app !== app) fail("receipt app mismatch"); if (receiptIds.has(receipt.receiptId)) fail("duplicate receipt ID"); receiptIds.add(receipt.receiptId); }
  const autoJudgeEvidence = object.autoJudgeEvidence === null ? null : parseAutoJudgeRef(object.autoJudgeEvidence);
  if (autoJudgeEvidence !== null && (autoJudgeEvidence.app !== app || !receiptReferences.some((receipt) => receipt.receiptId === autoJudgeEvidence.receiptId && receipt.captureSha256 === autoJudgeEvidence.captureSha256))) fail("auto-judge reference lacks matching receipt");
  const storedEvidenceCeiling = oneOf(object.storedEvidenceCeiling, ["structural", "auto_judged"] as const, "stored evidence ceiling");
  if ((storedEvidenceCeiling === "auto_judged") !== (autoJudgeEvidence !== null)) fail("stored evidence ceiling/auto-judge mismatch");
  const publicResult = object.publicResult === null ? null : parseSnapshotRef(object.publicResult, "public-result") as SnapshotRefV1 & { kind: "public-result" };
  if ((currentSpec === null) !== (briefPayload === null)) fail("current spec and brief payload must occur together");
  if ((transition.type === "spec-authored" || transition.type === "spec-amended") && (currentSpec === null || currentSpec.snapshot.sha256 !== transition.currentSpec)) fail("spec transition/current snapshot mismatch");
  if (transition.type === "plan-completed") {
    if (transition.outcome === "plan-failed" ? currentSpec !== null : currentSpec === null) fail("plan outcome/current spec mismatch");
  }
  const resultRequired = transition.type === "attempt-paused" || transition.type === "run-terminal" || transition.type === "policy-terminal"
    || (transition.type === "plan-completed" && transition.outcome !== "ready-to-build");
  if (resultRequired !== (publicResult !== null)) fail("transition/public result mismatch");

  const attemptTransition = ["attempt-started", "attempt-in-doubt", "attempt-paused", "attempt-conflicted", "iteration-completed", "run-terminal"].includes(transition.type);
  if (attemptTransition !== (attemptInputs !== null)) fail("transition/attempt inputs mismatch");
  if (attemptInputs === null && compiler.status !== "not-run") fail("compiler outcome requires attempt inputs");
  if (attemptInputs !== null && currentSpec === null) fail("attempt inputs require a current spec");
  if (workflow === "pico-build-app" && iteration.status !== "not-run") fail("build workflow cannot contain loop iteration state");
  if (workflow === "pico-loop" && iteration.status !== "not-run") {
    if (iteration.index > budget!.iterations || iteration.completedCount > budget!.iterations || iteration.nextIndex > budget!.iterations + 1) fail("iteration state exceeds the stored iteration budget");
  }
  if (transition.type === "iteration-completed" || transition.type === "policy-terminal") {
    if (workflow !== "pico-loop") fail(`${transition.type} is loop-only`);
  }
  if (transition.type === "attempt-started") {
    if ((workflow === "pico-build-app") !== (transition.phase === "build")) fail("attempt phase/workflow mismatch");
    if (workflow === "pico-loop" && (transition.iteration! > budget!.iterations || transition.iteration !== iteration.nextIndex)) fail("attempt iteration exceeds or disagrees with the stored budget state");
  }
  if (transition.type === "attempt-paused") {
    const allowed = workflow === "pico-build-app"
      ? ["failed", "built-not-installed", "built-no-capture"]
      : ["unmeasurable-acceptance", "no-progress", "manual-repair-required"];
    if (!allowed.includes(transition.publicStatus)) fail("paused public status/workflow mismatch");
    if (["built-not-installed", "built-no-capture"].includes(transition.publicStatus) && compiler.status !== "succeeded") fail("post-compile paused status requires succeeded compilation");
  }
  if (transition.type === "run-terminal") {
    const allowed = workflow === "pico-build-app"
      ? ["built-needs-look", "auto-judged-needs-look"]
      : ["accepted", "built-needs-look", "budget-exhausted", "failed"];
    if (!allowed.includes(transition.publicStatus)) fail("terminal public status/workflow mismatch");
    if (workflow === "pico-loop" && transition.publicStatus === "failed" && onFail !== "stop") fail("terminal loop failure requires stop policy");
    if (["built-needs-look", "auto-judged-needs-look", "accepted"].includes(transition.publicStatus) && (compiler.status !== "succeeded" || receiptReferences.length === 0)) fail("successful terminal status requires succeeded compilation and a receipt");
    if (transition.publicStatus === "auto-judged-needs-look" && autoJudgeEvidence === null) fail("auto-judged terminal status requires auto-judge evidence");
  }

  if (attemptTransition) {
    const lastAttempt = projectGeneration.lastAttempt;
    if (lastAttempt === null || !("attemptId" in transition) || lastAttempt.attemptId !== transition.attemptId) fail("transition/last attempt mismatch");
    if (transition.type === "attempt-started") {
      if (canonicalJson(lastAttempt.before) !== canonicalJson(transition.generation) || canonicalJson(projectGeneration.expected) !== canonicalJson(transition.generation)) fail("attempt-started generation mismatch");
      if (lastAttempt.after !== null || lastAttempt.attribution !== null || attemptInputs!.sha256 !== transition.inputs || compiler.status !== "not-run") fail("attempt-started state mismatch");
    } else if (transition.type === "attempt-in-doubt") {
      if (lastAttempt.after !== null || lastAttempt.attribution !== null || !["in-doubt", "succeeded"].includes(compiler.status)) fail("in-doubt attempt state mismatch");
    } else {
      if (lastAttempt.after === null || compiler.status === "in-doubt") fail("definite attempt outcome state mismatch");
      if (transition.type === "attempt-conflicted") {
        if (lastAttempt.attribution !== null || canonicalJson(projectGeneration.expected) !== canonicalJson(lastAttempt.before) || canonicalJson(transition.observed) !== canonicalJson(lastAttempt.after)) fail("conflicted attempt attribution mismatch");
      } else if (lastAttempt.attribution === null || canonicalJson(projectGeneration.expected) !== canonicalJson(lastAttempt.after)) fail("definite attempt attribution mismatch");
      if (transition.type === "iteration-completed" && (iteration.status === "not-run" || iteration.index !== transition.iteration)) fail("iteration transition/state mismatch");
    }
  }
  if (compiler.status === "in-doubt" && transition.type !== "attempt-in-doubt") fail("in-doubt compiler requires an in-doubt attempt");
  const receiptlessCompilerSuccessAllowed = workflow === "pico-build-app" && transition.type === "attempt-paused"
    && ["built-not-installed", "built-no-capture"].includes(transition.publicStatus);
  if (compiler.status === "succeeded" && receiptReferences.length === 0 && !receiptlessCompilerSuccessAllowed) fail("succeeded compiler lacks a definite receipt for this transition status");
  const attribution = projectGeneration.lastAttempt?.attribution ?? null;
  if (attribution?.compilerLedger !== null && attribution?.compilerLedger !== undefined) {
    if (compiler.status === "not-run" || compiler.ledger === null || compiler.ledger.sha256 !== attribution.compilerLedger) fail("generation attribution/compiler ledger mismatch");
  }
  if (attribution?.receiptId !== null && attribution?.receiptId !== undefined && !receiptReferences.some((receipt) => receipt.receiptId === attribution.receiptId)) fail("generation attribution lacks matching receipt");
  if (revision === 0) {
    if (transition.type !== "created" || lifecycle.status !== "open" || lifecycle.phase !== "ready-to-plan" || lifecycle.publicStatus !== null) fail("revision zero must be the created ready-to-plan state");
    if (projectGeneration.lastAttempt !== null || attemptInputs !== null || compiler.status !== "not-run" || iteration.status !== "not-run") fail("revision zero cannot contain attempt state");
    if (receiptReferences.length !== 0 || autoJudgeEvidence !== null || storedEvidenceCeiling !== "structural" || publicResult !== null) fail("revision zero cannot contain result or evidence state");
  } else if (transition.type === "created") fail("created transition is revision-zero only");
  const revisionId = shaValue(object.revisionId, "revisionId");
  const { revisionId: _omitted, ...identityPayload } = object;
  if (revisionId !== sha256(canonicalJson(identityPayload))) fail("revisionId mismatch");
  return {
    kind: "pico.workflow-run-revision", schemaVersion: 1, runId, revision, revisionId, parent,
    createdAt: timestamp(object.createdAt, "createdAt"), workflow,
    intent: { goal, acceptance, initialSpec, currentSpec, briefPayload, budget, onFail, execution: { fleetSettleSec: 16 } },
    target: { briefInput, briefId, app, executionSerial: "emulator-5554", inputBaseDir, briefPath, projectDir, projectLocator, resourceKey, projectResourceKey, base },
    transition, projectGeneration, attemptInputs, compiler, receiptReferences, autoJudgeEvidence,
    iteration, publicResult, lifecycle, storedEvidenceCeiling,
  };
}

export function parseRunHead(value: unknown): RunHeadV1 {
  inspectCanonical(value, STRING_MAX_BYTES, "run head");
  const object = record(value, ["kind", "schemaVersion", "runId", "revision", "revisionId", "updatedAt"], "run head");
  return { kind: literal(object.kind, "pico.workflow-run-head", "head kind"), schemaVersion: literal(object.schemaVersion, 1, "head schemaVersion"), runId: uuidValue(object.runId, "head runId"), revision: integer(object.revision, "head revision", 0, RUN_REVISION_MAX - 1), revisionId: shaValue(object.revisionId, "head revisionId"), updatedAt: timestamp(object.updatedAt, "head updatedAt") };
}

export function parseRunControlResult(value: unknown): RunControlResultV1 {
  inspectCanonical(value, PUBLIC_RESULT_MAX_BYTES, "run control result");
  const object = record(value, ["status", "runId", "revision", "revisionId", "expectedRevision", "actualRevision", "actualRevisionId", "runStateByThisCall", "externalSideEffectsByThisCall", "priorAttemptExternalSideEffects", "activeAttemptExternalSideEffects", "inDoubtAttemptCompletion", "runRevisionCommitted", "runRevisionPublication", "expectedGeneration", "observedGeneration", "historicalResult", "issues", "detail", "fix"], "run control result");
  const status = oneOf(object.status, ["invalid-invocation", "invalid-policy", "invalid-run-id", "run-not-found", "run-busy", "revision-conflict", "intent-conflict", "acceptance-conflict", "spec-conflict", "target-conflict", "recovery-required", "interrupted-in-doubt", "external-state-conflict", "invalid-store", "limit-exceeded", "revision-limit", "state-write-failed"] as const, "run control status");
  const runId = object.runId === null ? null : uuidValue(object.runId, "control runId");
  const revision = object.revision === null ? null : integer(object.revision, "control revision", 0, RUN_REVISION_MAX - 1);
  const revisionId = object.revisionId === null ? null : shaValue(object.revisionId, "control revisionId");
  if ([runId, revision, revisionId].filter((item) => item !== null).length % 3 !== 0) fail("control coordinate must be all null or all present");
  const expectedRevision = object.expectedRevision === null ? null : integer(object.expectedRevision, "expectedRevision", 0, RUN_REVISION_MAX - 1);
  const actualRevision = object.actualRevision === null ? null : integer(object.actualRevision, "actualRevision", 0, RUN_REVISION_MAX - 1);
  const actualRevisionId = object.actualRevisionId === null ? null : shaValue(object.actualRevisionId, "actualRevisionId");
  const comparisonCount = [expectedRevision, actualRevision, actualRevisionId].filter((item) => item !== null).length;
  if (comparisonCount !== 0 && comparisonCount !== 3) fail("revision comparison fields must be all null or all present");
  if ((status === "revision-conflict") !== (comparisonCount === 3)) fail("revision conflict comparison fields mismatch");
  if (["invalid-invocation", "invalid-policy", "invalid-run-id", "run-not-found"].includes(status) && runId !== null) fail("pre-run control status cannot carry coordinates");
  const expectedGeneration = object.expectedGeneration === null ? null : parseGeneration(object.expectedGeneration);
  const observedGeneration = object.observedGeneration === null ? null : parseGeneration(object.observedGeneration);
  if ((expectedGeneration === null) !== (observedGeneration === null)) fail("generation comparison fields must occur together");
  if ((status === "external-state-conflict") !== (expectedGeneration !== null && observedGeneration !== null)) fail("external-state-conflict generation fields mismatch");
  if (object.historicalResult !== null) fail("run control result historicalResult must be null");
  if (!Array.isArray(object.issues) || object.issues.length > 64) fail("run control issues limit exceeded");
  const runRevisionCommitted = object.runRevisionCommitted === null ? null : bool(object.runRevisionCommitted, "runRevisionCommitted");
  const runRevisionPublication = object.runRevisionPublication === null ? null : oneOf(object.runRevisionPublication, ["not-linked", "linked-head-pending", "head-authoritative", "unknown"] as const, "runRevisionPublication");
  const runStateByThisCall = oneOf(object.runStateByThisCall, ["unchanged", "durably-advanced", "publication-in-doubt"] as const, "runStateByThisCall");
  const publicationState = runRevisionCommitted === null && runRevisionPublication === null ? "unchanged"
    : runRevisionCommitted === false && runRevisionPublication === "not-linked" ? "unchanged"
      : runRevisionCommitted === false && runRevisionPublication === "linked-head-pending" ? "publication-in-doubt"
        : runRevisionCommitted === null && runRevisionPublication === "unknown" ? "publication-in-doubt"
          : runRevisionCommitted === true && runRevisionPublication === "head-authoritative" ? "durably-advanced"
            : null;
  if (publicationState === null || runStateByThisCall !== publicationState) fail("run revision publication tuple is invalid");
  const externalSideEffectsByThisCall = oneOf(object.externalSideEffectsByThisCall, ["none", "possible", "confirmed"] as const, "externalSideEffectsByThisCall");
  const priorAttemptExternalSideEffects = object.priorAttemptExternalSideEffects === null ? null : oneOf(object.priorAttemptExternalSideEffects, ["possible", "confirmed"] as const, "priorAttemptExternalSideEffects");
  const activeAttemptExternalSideEffects = object.activeAttemptExternalSideEffects === null ? null : literal(object.activeAttemptExternalSideEffects, "possible", "activeAttemptExternalSideEffects");
  const inDoubtAttemptCompletion = object.inDoubtAttemptCompletion === null ? null : literal(object.inDoubtAttemptCompletion, "unknown", "inDoubtAttemptCompletion");
  const preRunStatus = ["invalid-invocation", "invalid-policy", "invalid-run-id", "run-not-found"].includes(status);
  if (preRunStatus && (runStateByThisCall !== "unchanged" || externalSideEffectsByThisCall !== "none" || runRevisionCommitted !== null || runRevisionPublication !== null || priorAttemptExternalSideEffects !== null || activeAttemptExternalSideEffects !== null || inDoubtAttemptCompletion !== null)) fail("pre-run rejection cannot claim durable or external mutation");
  return {
    status, runId, revision, revisionId, expectedRevision, actualRevision, actualRevisionId,
    runStateByThisCall,
    externalSideEffectsByThisCall,
    priorAttemptExternalSideEffects,
    activeAttemptExternalSideEffects,
    inDoubtAttemptCompletion,
    runRevisionCommitted, runRevisionPublication, expectedGeneration, observedGeneration, historicalResult: null,
    issues: object.issues.map((issue) => parseDiagnostic(issue, "control issue")), detail: stringValue(object.detail, "control detail"), fix: stringValue(object.fix, "control fix"),
  };
}
