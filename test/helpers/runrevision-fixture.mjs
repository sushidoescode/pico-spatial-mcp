import crypto from "node:crypto";
import path from "node:path";
import { canonicalJson } from "../../dist/runreceiptidentity.js";

export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);
export const SHA_C = "c".repeat(64);
export const RUN_ID = "12345678-1234-4234-9234-123456789abc";
export const ATTEMPT_ID = "abcdefab-cdef-4abc-8def-abcdefabcdef";

export const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

export const authoredSpec = Object.freeze({
  meta: {
    appName: "RunRevisionFixture",
    packageName: "com.example.runrevision",
    brief: "strict value fixture",
  },
  scenes: [{ id: "main", environment: { kind: "procedural" } }],
  navigation: { startScene: "main" },
});

export const parsedSpecCanonical =
  '{"data":[],"headsetLayer":[],"interactions":[],"layouts":[],"meta":{"appName":"RunRevisionFixture","brief":"strict value fixture","packageName":"com.example.runrevision","rootContainer":"stage","secondaryContainers":[],"stageStyle":"1"},"navigation":{"portals":[],"startScene":"main"},"objects":[],"panels":[],"scenes":[{"colliders":{"props":[]},"environment":{"kind":"procedural"},"id":"main","lighting":{"rig":"sun"},"transitions":[]}],"verificationPlan":[]}';

export function snapshotRef(kind, sha256 = SHA_A, bytes = 123) {
  return { kind, algorithm: "sha256", sha256, bytes };
}

export function diagnostic(code = "fixture", detail = "fixture detail") {
  return { code, detail, detailSha256: sha(detail) };
}

export const absentGeneration = Object.freeze({
  brief: { status: "absent" },
  project: { status: "absent" },
});

export function revisionIdOf(revision) {
  const { revisionId: _omitted, ...payload } = revision;
  return sha(canonicalJson(payload));
}

export function refreshRevisionId(revision) {
  const copy = structuredClone(revision);
  copy.revisionId = revisionIdOf(copy);
  return copy;
}

export function baseRevision(overrides = {}) {
  const physicalProjectsRoot = path.resolve("/tmp/pico-runrevision-projects");
  const projectDir = path.join(physicalProjectsRoot, "fleet-door238151-native");
  const anchorPath = path.parse(physicalProjectsRoot).root;
  const resourceKey = sha(canonicalJson({
    kind: "pico.application-resource",
    schemaVersion: 1,
    app: "com.fleet.door238151",
    serial: "emulator-5554",
  }));
  const projectResourceKey = sha(canonicalJson({
    kind: "pico.physical-project-resource",
    schemaVersion: 1,
    physicalProjectDir: projectDir,
  }));
  const revision = {
    kind: "pico.workflow-run-revision",
    schemaVersion: 1,
    runId: RUN_ID,
    revision: 0,
    revisionId: SHA_A,
    parent: null,
    createdAt: "2026-08-16T12:00:00.000Z",
    workflow: "pico-build-app",
    intent: {
      goal: snapshotRef("goal"),
      acceptance: null,
      initialSpec: null,
      currentSpec: null,
      briefPayload: null,
      budget: null,
      onFail: null,
      execution: { fleetSettleSec: 16 },
    },
    target: {
      briefInput: "Fixture",
      briefId: "door238151",
      app: "com.fleet.door238151",
      executionSerial: "emulator-5554",
      inputBaseDir: physicalProjectsRoot,
      briefPath: path.join(physicalProjectsRoot, "door238151.json"),
      projectDir,
      projectLocator: {
        kind: "pico.project-locator",
        schemaVersion: 1,
        requestedProjectsRoot: physicalProjectsRoot,
        physicalProjectsRoot,
        requestedProjectDir: projectDir,
        physicalProjectDir: projectDir,
        anchor: {
          requestedPath: anchorPath,
          physicalPath: anchorPath,
          device: "1",
          inode: "2",
        },
        missingSuffix: physicalProjectsRoot.split(path.sep).filter(Boolean).concat(["fleet-door238151-native"]),
      },
      resourceKey,
      projectResourceKey,
      base: null,
    },
    transition: { type: "created" },
    projectGeneration: { expected: absentGeneration, lastAttempt: null },
    attemptInputs: null,
    compiler: { status: "not-run" },
    receiptReferences: [],
    autoJudgeEvidence: null,
    iteration: {
      status: "not-run",
      nextIndex: 1,
      completedCount: 0,
      previousFailureSignature: null,
    },
    publicResult: null,
    lifecycle: { status: "open", phase: "ready-to-plan", publicStatus: null },
    storedEvidenceCeiling: "structural",
    ...structuredClone(overrides),
  };
  revision.revisionId = revisionIdOf(revision);
  return revision;
}

export function revisionOne(overrides = {}) {
  return baseRevision({
    revision: 1,
    parent: { revision: 0, revisionId: SHA_C },
    ...structuredClone(overrides),
  });
}

const currentSpecIntent = () => ({
  snapshot: snapshotRef("app-spec", SHA_B),
  origin: "caller-authored",
  amendsRevision: null,
});

const loopIntent = () => ({
  ...baseRevision().intent,
  acceptance: snapshotRef("acceptance", SHA_C),
  currentSpec: currentSpecIntent(),
  briefPayload: snapshotRef("brief-payload", SHA_C),
  budget: { iterations: 3, timeMin: 20, toolCalls: "inert" },
  onFail: "replan",
});

const lastAttempt = (after, attribution) => ({
  attemptId: ATTEMPT_ID,
  before: absentGeneration,
  after,
  attribution,
});

export function transitionRevision(transition, lifecycle) {
  const commonIntent = {
    ...baseRevision().intent,
    currentSpec: currentSpecIntent(),
    briefPayload: snapshotRef("brief-payload", SHA_C),
  };
  const externalInput = snapshotRef("external-input", SHA_A);
  const publicResult = snapshotRef("public-result", SHA_C);
  const compilerFailed = {
    status: "failed",
    ledger: snapshotRef("compiler-ledger", SHA_B),
    phase: "compiler",
    failure: diagnostic(),
    plannedCount: 1,
    completedCount: 0,
    elapsedMs: 1,
    executionDisposition: "definitely-completed",
  };
  const definiteGeneration = {
    expected: absentGeneration,
    lastAttempt: lastAttempt(absentGeneration, {
      status: "fleet-write-set",
      compilerLedger: SHA_B,
      receiptId: null,
    }),
  };
  const attemptState = {
    intent: commonIntent,
    attemptInputs: externalInput,
    projectGeneration: {
      expected: absentGeneration,
      lastAttempt: lastAttempt(null, null),
    },
  };
  if (transition.type === "created") return baseRevision({ transition, lifecycle });
  if (transition.type === "spec-authored" || transition.type === "spec-amended") {
    return revisionOne({ intent: commonIntent, transition, lifecycle });
  }
  if (transition.type === "plan-completed") {
    return revisionOne({
      intent: transition.outcome === "plan-failed" ? baseRevision().intent : commonIntent,
      transition,
      lifecycle,
      publicResult: transition.outcome === "ready-to-build" ? null : publicResult,
    });
  }
  if (transition.type === "attempt-started") {
    return revisionOne({ ...attemptState, transition, lifecycle });
  }
  if (transition.type === "attempt-in-doubt") {
    return revisionOne({
      ...attemptState,
      transition,
      lifecycle,
      compiler: {
        status: "in-doubt",
        ledger: null,
        phase: "fleet-build",
        reason: diagnostic(),
        plannedCount: null,
        completedCount: null,
        elapsedMs: null,
        executionDisposition: "in-doubt",
      },
    });
  }
  if (transition.type === "attempt-conflicted") {
    return revisionOne({
      intent: commonIntent,
      attemptInputs: externalInput,
      projectGeneration: { expected: absentGeneration, lastAttempt: lastAttempt(absentGeneration, null) },
      compiler: compilerFailed,
      transition,
      lifecycle,
    });
  }
  if (transition.type === "attempt-paused") {
    return revisionOne({
      intent: commonIntent,
      attemptInputs: externalInput,
      projectGeneration: definiteGeneration,
      compiler: compilerFailed,
      transition,
      lifecycle,
      publicResult,
    });
  }
  if (transition.type === "iteration-completed") {
    return revisionOne({
      workflow: "pico-loop",
      intent: loopIntent(),
      attemptInputs: externalInput,
      projectGeneration: definiteGeneration,
      compiler: compilerFailed,
      iteration: {
        status: "blocked",
        index: transition.iteration,
        completedCount: transition.iteration,
        nextIndex: transition.iteration + 1,
        failure: diagnostic(),
        previousFailureSignature: null,
        structuralLedger: { status: "not-recorded", reason: diagnostic() },
      },
      transition,
      lifecycle,
    });
  }
  if (transition.type === "run-terminal") {
    const receipt = {
      kind: "pico.native-run-receipt",
      schemaVersion: 1,
      app: "com.fleet.door238151",
      receiptId: SHA_A,
      captureSha256: SHA_B,
    };
    return revisionOne({
      intent: commonIntent,
      attemptInputs: externalInput,
      projectGeneration: {
        expected: absentGeneration,
        lastAttempt: lastAttempt(absentGeneration, {
          status: "receipt-and-fleet-write-set",
          compilerLedger: SHA_B,
          receiptId: SHA_A,
        }),
      },
      compiler: {
        status: "succeeded",
        ledger: snapshotRef("compiler-ledger", SHA_B),
        plannedCount: 1,
        completedCount: 1,
        elapsedMs: 1,
        executionDisposition: "definitely-completed",
      },
      receiptReferences: [receipt],
      transition,
      lifecycle,
      publicResult,
    });
  }
  return revisionOne({
    workflow: "pico-loop",
    intent: loopIntent(),
    transition,
    lifecycle,
    publicResult,
  });
}

export function goalEnvelope(goal = "Fixture") {
  return { kind: "pico.workflow-goal", schemaVersion: 1, goal };
}

export function buildWork(status, overrides = {}) {
  const receiptBearing = status === "auto-judged-needs-look" || status === "built-needs-look";
  const result = {
    status,
    briefId: "door238151",
    built: status !== "failed",
    installed: !["failed", "built-not-installed"].includes(status),
    verdict: null,
    autoJudgedRecorded: status === "auto-judged-needs-look",
    receiptId: receiptBearing ? SHA_A : null,
    receiptPath: receiptBearing ? "/tmp/receipts/receipt.json" : null,
    capture: receiptBearing ? "/tmp/captures/frame.png" : null,
    notes: [],
    projectDir: "/tmp/project",
    honesty: "structural fixture only",
    ...overrides,
  };
  if (["failed", "built-not-installed", "built-no-capture"].includes(status)) {
    result.fix = "fixture fix";
  }
  return result;
}

export function loopCommon(overrides = {}) {
  return {
    iterations: 1,
    briefId: "door238151",
    projectDir: "/tmp/project",
    scaffoldStarted: true,
    iterationsLog: [{
      iteration: 1,
      outcomes: [{
        inputIndex: 0,
        criterionDigest: SHA_A,
        kind: "structural",
        status: "pass",
        detail: null,
        machineVerdict: null,
        recordedEvidence: null,
        failureClass: null,
        machineChecks: [],
      }],
      capture: null,
      receiptId: null,
      receiptPath: null,
      ledger: "structural fixture ledger",
    }],
    ...overrides,
  };
}
