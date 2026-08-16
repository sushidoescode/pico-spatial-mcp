# Revisioned Run and Resume Store v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make Door 1 and pico_loop persist strict immutable workflow revisions, resume from exact optimistic coordinates after process restart, serialize cooperating application/project writers, and replay only freshly revalidated structural or auto-judged authority.

**Architecture:** Strict contract and filesystem modules own canonical snapshots, revision/HEAD publication, complete bounded scans, target lineages, and POSIX owner generations. A separate locator/input module binds physical project generations and sealed attempt inputs; Fleet exposes one private capability-driven execution core; focused Door 1, loop, projection, and pico_next modules orchestrate those primitives while doors.ts retains MCP registration and the 18-tool surface.

**Tech Stack:** TypeScript in strict NodeNext mode on Node.js 20+, Zod, Node crypto/fs/path/process APIs, MCP SDK, existing receipt/ledger validators, injected clocks/UUID/process/runner seams, and Node's built-in test runner with real temporary files and child-process crash fixtures.

## Global Constraints

- Work from reviewed design commit acdbebb6db2aabd72b2f3320b8dced7fa9b1864c. Do not rework managed-latest unless a reproduced regression requires it.
- The default store root is ~/.pico-mcp/runs and hermetic tests use PICO_MCP_RUN_DIR. The configured root is the complete authority; changing it is supported only for genuinely new, nonoccupied targets and never authorizes adoption of occupied mutable state.
- V1 durability/concurrency claims are POSIX-only. Do not claim native Windows, Swan, hardware Safeguard/Guardian, emulator restoration, installed-app restoration, source rollback, or rendered appearance.
- A run ID is a server-generated canonical lowercase UUIDv4. Revision numbers start at zero, are contiguous unsigned decimal integers without signs or leading zeroes, and stop before 256 revisions.
- Every resume mutation supplies runId plus expectedRevision. Stale writers, changed immutable intent, corrupt state, ambiguous execution, and unattributed surviving project changes fail closed before another attempt.
- Snapshot and revision files are strict canonical JSON plus one newline. Snapshot digest/bytes exclude that newline; revisionId hashes the canonical revision with only revisionId omitted.
- Persistent publication uses a unique same-directory staging file, descriptor flush, create-only link, staging unlink, directory flush, then atomic HEAD replacement and run-directory flush. Existing revisions are never overwritten.
- Acquire run, application, and physical-project owners in that order; public Fleet acquires application then project. Release/quarantine in reverse order only after durable definite authority.
- Owner records require PID plus process-start identity and random tokens. Live owners are never stolen by age. In-doubt execution retains all owners and has no V1 unlock/reconciliation path.
- No Fleet/generator/Gradle/adb/ledger/receipt/install/launch/capture operation occurs before attempt-started is the durable HEAD and its exact sealed input capability is valid.
- Goal bounds are 256 KiB before normalization and 64 KiB after CR/CRLF-to-LF, NFC, outer-Unicode-whitespace trim. The original exact brief remains the compatibility target identity.
- Acceptance is ordered, duplicate-preserving, capped at 64 criteria and 256 KiB. Policy defaults are iterations 3, timeMin 20, onFail replan; toolCalls normalizes to literal inert; timeMin is finite 0..1440 and per active invocation.
- Project identity reuses the unchanged receipt policy pico-native-receipt-gradle-input-v1 and binds physical path/device/inode plus its exact Gradle-input identity. Do not duplicate or weaken that collector.
- Sealed executions allow 256 logical uses, 256 unique files, 16 KiB paths, 64 MiB semantic/occupancy JSON, 256 MiB KTX, 512 MiB model/sidecar/splat/pano, and 2 GiB aggregate, charged before allocation or hashing.
- Model dependency order is AppSpec encounter order, then stable GLTF buffer/image array order. Inline data URIs are self-contained; decoded safe relative file URIs are sidecars; schemes, scheme-relative paths, absolute paths, backslashes, fragments/queries, and decoded traversal reject.
- V1 rejects loose USD dependencies until a bounded enumerator exists. Proven no-lineage legacy Fleet retains its accepted mutable lookup/model/size behavior and receives no V1 external-input authority.
- Root scans encounter at most 4,096 entries; lock namespaces at most 4,096 each/12,288 aggregate; one run directory 1,024 entries; aggregate nested entries 65,536; aggregate revisions 16,384; CAS objects 32,768; scan bytes 512 MiB.
- Per object limits are 2 MiB AppSpec/external input, 3 MiB brief payload, 8 MiB compiler ledger, 4 MiB public result, and 512 MiB unique snapshots per run. Compiler ledgers allow 4,096 steps and 20,000 write records.
- Stored receipt refs are at most six and are accepted/replayed only through exact historical validators. Stored evidence is structural or auto_judged only; persisted vision_verified/device_verified is invalid.
- A receipt, build, log, automated judge, run revision, or replay is structural workflow evidence. A visual conclusion still requires opening and judging the exact receipt-bound capture.
- Preserve current initial forms, result fields/statuses, briefId/package/project mappings, text JSON transport, and the literal AGENTS.md {brief} then {brief,draftSpec} flow, subject only to the reviewed fail-closed occupied-target exceptions.
- Keep Doors at exactly 18 tools. Do not add a Door or alter visibility, permissions, remotes, publication state, or the separately owned Windows lane.
- Each task commits measured RED/GREEN commands and counts that actually ran. Final claims distinguish the known optional local scene_schemas smoke failure from passing gates.
- The command lists in commit examples are requirements, not copy-ready evidence. Before every task commit, replace them with the exact observed exit status and test pass/fail/skip counts from that task's fresh output; a command-only or predicted count is not an acceptable commit claim.

## File Responsibility Map

- Create src/runrevisiontypes.ts: strict pure value grammars, normalizers, cross-field parsers, and bounded diagnostics.
- Create src/runrevisionstore.ts: safe paths, immutable CAS/revisions/HEAD, complete scans, lineage/admission, and store-aware recovery classification.
- Create src/runlocks.ts: owner generations, fixed acquisition/release order, public markers, recovery elections, and mutation authorities.
- Create src/fleetinputidentity.ts: physical locator/generation, compatibility-brief observation, external manifests, sealed views, and branded capabilities.
- Create src/runprojection.ts: receipt/auto-judge revalidation and exact/stripped/downgraded/broken replay.
- Create src/buildapprun.ts and src/picoloop.ts: focused revisioned workflow state machines.
- Create src/runnext.ts: complete run-store routing and immutable action projection.
- Modify src/fleetbuild.ts: extract executeFleetBuild and coordinate the public wrapper.
- Modify src/nativefleetreceipt.ts: additive definite/in-doubt disposition without changing receipt v1.
- Modify src/ledger.ts: exact producer-valid auto-judge event resolver; do not broaden caller evidence authority.
- Modify src/doors.ts: additive schemas/descriptions and delegation while retaining helper re-exports/tool count.

---

### Task 1: Strict run contracts, normalization, and bounded value grammars

**Files:**
- Create: src/runrevisiontypes.ts
- Create: test/helpers/runrevision-fixture.mjs
- Create: test/runrevision-contracts.mjs
- Modify: package.json

**Interfaces:**
- Produces normalizeGoal(original: string): { original: string; normalized: string; digest: string }
- Produces normalizeAcceptance(criteria: unknown[]): { envelope: AcceptanceSnapshotV1; refDigest: string }
- Produces normalizeLoopPolicy(budget: unknown, onFail: unknown): NormalizedLoopPolicyV1
- Produces boundedDiagnostic(code: string, detail: string): BoundedDiagnosticV1
- Produces parseSnapshotEnvelope(kind: SnapshotRefV1["kind"], value: unknown): SnapshotEnvelopeV1
- Produces parsePublicResult(workflow: RunWorkflowV1, value: unknown): BuildAppPublicResultV1 | PicoLoopPublicResultV1
- Produces parseRunRevision(value: unknown): RunRevisionV1
- Produces parseRunHead(value: unknown): RunHeadV1
- Produces parseRunControlResult(value: unknown): RunControlResultV1
- Re-exports the exact strict unions named in the approved design: snapshot refs/envelopes, locator/generation, compiler/iteration/lifecycle/transition, receipt/auto-event refs, Fleet envelope, replay/projection metadata, and run-control results.
- Produces these exact shared aliases so later tasks do not invent parallel shapes:

~~~ts
export type RunWorkflowV1 = "pico-build-app" | "pico-loop";
export type RunTargetV1 = RunRevisionV1["target"];
export type BuildInvocationParseV1 =
  | { ok: true; value: BuildAppInvocationV1 }
  | { ok: false; result: RunControlResultV1 & { status: "invalid-invocation" } };
export type LoopInvocationParseV1 =
  | { ok: true; value: PicoLoopInvocationV1 }
  | { ok: false; result: RunControlResultV1 & {
      status: "invalid-invocation" | "invalid-policy" } };
export type SnapshotEnvelopeV1 =
  | GoalSnapshotV1 | AcceptanceSnapshotV1 | AppSpecSnapshotV1
  | BriefPayloadSnapshotV1 | ExternalInputSnapshotV1
  | CompilerLedgerSnapshotV1 | PublicResultSnapshotV1;
export type NormalizedRunIntentV1 = Readonly<{
  workflow: RunWorkflowV1;
  goal: GoalSnapshotV1;
  acceptance: AcceptanceSnapshotV1 | null;
  initialSpec: AppSpecSnapshotV1 | null;
  budget: null | { iterations: number; timeMin: number; toolCalls: "inert" };
  onFail: null | "replan" | "stop";
  execution: { fleetSettleSec: 16 };
}>;
export type NormalizedLoopPolicyV1 = Readonly<{
  budget: { iterations: number; timeMin: number; toolCalls: "inert" };
  onFail: "replan" | "stop";
}>;
export type RunStoreMutationRequestV1 = Readonly<{
  runId: LowercaseUuidV4;
  expectedRevision: number | null;
  ownerToken: LowercaseUuidV4;
  mode: "coordination" | "execution" | "recovery";
}>;
export type ExternalPhaseCallResultV1<T> =
  | { executionDisposition: "definitely-completed";
      externalMutationDisposition: "none" | "possible" | "confirmed";
      value: T }
  | { executionDisposition: "in-doubt";
      externalMutationDisposition: "possible" | "confirmed";
      phase: ExternalPhaseV1;
      reason: BoundedDiagnosticV1 };
~~~

Task 2 defines CoreRunChainV1 and RunRevisionStoreV1. Task 5 combines Task 2 core state
with Task 3 physical-target validation and lineage checks to define ValidatedRunChainV1 and
target scan/classification/admission results. Task 7 defines ValidatedFleetExecutionV1. Task 8
defines FleetPublicRecordV1. Task 9 defines RunProjectionV1. Those types are consumed only after
their producing task.

- [ ] **Step 1: Write the failing contract tests**

Create literal, hand-derived fixtures that exercise real exported parsers:

~~~js
test("goal normalization preserves raw target bytes while canonicalizing intent", () => {
  const got = normalizeGoal("  Cafe\u0301\r\nRoom  ");
  assert.equal(got.original, "  Cafe\u0301\r\nRoom  ");
  assert.equal(got.normalized, "Café\nRoom");
  assert.equal(got.digest, sha('{"goal":"Café\\nRoom","kind":"pico.workflow-goal","schemaVersion":1}'));
});

test("acceptance preserves order and duplicates while digesting strict per-kind values", () => {
  const got = normalizeAcceptance([
    { kind: "visual", pattern: "ignored" },
    { kind: "visual" },
    { kind: "logcat", pattern: "READY" },
  ]);
  assert.deepEqual(got.envelope.criteria.map((x) => [x.inputIndex, x.kind]), [
    [0, "visual"], [1, "visual"], [2, "logcat"],
  ]);
  assert.notEqual(got.envelope.criteria[0].criterionDigest, got.envelope.criteria[1].criterionDigest);
});
~~~

Add tables that name the production break each row catches:

- CRLF/LF, bare CR, NFC, outer whitespace, internal tabs/newlines, empty/control/oversize goals;
- AppSpec schema default expansion and canonical unsafe JSON rejection;
- exact structural/visual/logcat/perf defaults, ignored cross-kind fields, duplicate indices/digests, 64/+1 criteria, canonical byte cap;
- budget defaults, inert toolCalls, iterations 1..6, timeMin negative/zero/fractional/1440/+epsilon, replan/stop;
- strict workflow-specific public results, forbidden cross-status keys, receipt triple presence, build booleans, loop criterion identity/order;
- every transition/lifecycle/compiler/iteration pairing and impossible receipt/evidence combination;
- unknown keys/kinds/versions, unsafe prototypes/accessors/cycles/sparse arrays/depth 32/+1, finite-number and string/array/object bounds;
- persisted vision_verified/device_verified and stored ceiling outside structural/auto_judged reject.

- [ ] **Step 2: Run RED and record the expected failure**

Run:

~~~sh
npm run build && node --test test/runrevision-contracts.mjs
~~~

Expected: build or test fails because dist/runrevisiontypes.js and its exports do not exist; no test may pass by inspecting source text.

- [ ] **Step 3: Implement the minimal strict value layer**

Use existing canonicalJson and appSpecSchema rather than a second canonicalizer/schema:

~~~ts
export const RUN_REVISION_MAX = 256;
export const RUN_REVISION_MAX_BYTES = 512 * 1024;
export const RUN_ACCEPTANCE_MAX = 64;
export const RUN_ACCEPTANCE_MAX_BYTES = 256 * 1024;

export function boundedDiagnostic(code: string, detail: string): BoundedDiagnosticV1 {
  const retained = scrubDiagnostic(detail);
  return {
    code: assertBoundedCode(code),
    detail: Buffer.from(retained).subarray(0, 4 * 1024).toString(),
    detailSha256: sha256(retained),
  };
}
~~~

Implement explicit discriminated-union parsing with unknown-key rejection and cross-field validation. Keep public MCP compatibility parsing outside this module; these parsers accept only normalized internal state. Derive criterion digests from canonical criteria with criterionDigest omitted and revisionId from the revision with only revisionId omitted.

- [ ] **Step 4: Run GREEN and regression checks**

Run:

~~~sh
npm run build
node --test test/runrevision-contracts.mjs
npm run test:runreceipt
git diff --check
~~~

Expected: all contract and receipt tests pass with zero failures.

- [ ] **Step 5: Add the focused package gate and commit measured claims**

Set:

~~~json
"test:runrevision": "node --test test/runrevision-contracts.mjs"
~~~

Commit only Task 1 files with message:

~~~text
feat(run): add strict revision contracts

RED: npm run build && node --test test/runrevision-contracts.mjs (missing module/exports).
GREEN: npm run build; npm run test:runrevision; npm run test:runreceipt; git diff --check.
Structural hermetic fixtures only; no emulator, Windows, Swan, hardware, or rendered LOOK claim.
~~~

---

### Task 2: Immutable CAS, revision chain, HEAD, and crash cuts

**Files:**
- Create: src/runrevisionstore.ts
- Create: test/runrevision-store.mjs
- Create: test/fixtures/runrevision-crash-child.mjs
- Modify: package.json

**Interfaces:**
- Consumes Task 1 strict types/parsers and existing canonicalJson.
- Produces runStoreRoot(options?: { rootDir?: string }): string
- Produces createRunRevisionStore(deps: RunRevisionStoreDependenciesV1, options?: RunStoreOptionsV1): RunRevisionStoreV1
- RunRevisionStoreV1 methods are publishSnapshot(kind: SnapshotRefV1["kind"], envelope: SnapshotEnvelopeV1): SnapshotRefV1; publishRevision(candidate: RunRevisionV1, request: RunStoreMutationRequestV1): PublishedRevisionV1; publishHead(expected: RunHeadV1 | null, next: RunHeadV1, request: RunStoreMutationRequestV1): void; readCommittedRun(runId: LowercaseUuidV4, validators: RunCoreValidatorsV1): CoreRunChainV1; and recoverLinkedTail(runId: LowercaseUuidV4, request: RunStoreMutationRequestV1): RecoveryResultV1.
- Produces exact store results:

~~~ts
export type RunRevisionStoreDependenciesV1 = Readonly<{
  assertMutationAuthority(
    request: RunStoreMutationRequestV1,
    target: { runId: LowercaseUuidV4; operation: "revision" | "head" },
  ): void;
  assertRecoveryAuthority(
    request: RunStoreMutationRequestV1,
    target: { runId: LowercaseUuidV4; tailRevision: number },
  ): void;
  nowUtc(): CanonicalUtcTimestamp;
}>;
export type RunStoreOptionsV1 = Readonly<{ rootDir?: string }>;
export type RunCoreValidatorsV1 = Readonly<{
  parseRevision(value: unknown): RunRevisionV1;
  parseHead(value: unknown): RunHeadV1;
  parseSnapshot(kind: SnapshotRefV1["kind"], value: unknown): SnapshotEnvelopeV1;
}>;
export type CoreRunChainV1 = Readonly<{
  head: RunHeadV1;
  revisions: readonly RunRevisionV1[];
  snapshots: ReadonlyMap<string, SnapshotEnvelopeV1>;
  issues: readonly BoundedDiagnosticV1[];
  validation: "core-only";
}>;
export type PublishedRevisionV1 = Readonly<{
  revision: RunRevisionV1;
  path: string;
  publication: "linked-head-pending";
}>;
export type RecoveryResultV1 =
  | { status: "unchanged"; chain: CoreRunChainV1 }
  | { status: "head-advanced"; chain: CoreRunChainV1;
      recoveredRevision: number }
  | (RunControlResultV1 & {
      status: "recovery-required" | "interrupted-in-doubt"
        | "invalid-store" | "state-write-failed" });
~~~

Task 2 has no unsafe default authority and no dependency on runlocks.ts. Its fixture injects a private-symbol verifier that accepts only capabilities minted by test/helpers/runrevision-fixture.mjs. Task 4 supplies the real owner-file/token verifier and integration tests; callers never select a permissive verifier.

- [ ] **Step 1: Write failing safe-store and crash tests**

Use a real temporary store and literal canonical bytes:

~~~js
test("snapshot identity excludes only the publication newline", () => {
  const envelope = { kind: "pico.workflow-goal", schemaVersion: 1, goal: "room" };
  const ref = publishSnapshot("goal", envelope, fixture.options);
  const canonical = '{"goal":"room","kind":"pico.workflow-goal","schemaVersion":1}';
  assert.equal(ref.bytes, Buffer.byteLength(canonical));
  assert.equal(ref.sha256, sha(canonical));
  assert.equal(fs.readFileSync(objectPath(ref), "utf8"), canonical + "\n");
});
~~~

Cover create/read/append through the private-symbol fixture authority, rejection of a plain/cloned request by the injected verifier, exact parent/revision ID, immutable old revisions, strict HEAD, missing/wrong CAS, noncanonical bytes, gaps, filename/parent/head mismatch, symlink/hard-link leaves, unsafe path components, replacement races, and each exact/+1 object/run/root aggregate bound.

The child fixture exposes barriers before revision link, after link, after staging unlink, after directory flush, before/after HEAD rename, and after run-directory flush. Parent SIGKILL plus a fresh process must prove:

- staging-only is unpublished;
- target plus staging alias is invalid-store and preserved;
- one alias-free contiguous tail is recovery-required;
- attempt-started tail recovery retains all three owners as interrupted-in-doubt;
- HEAD never moves backward or skips corrupt state;
- revision zero without HEAD is the only recoverable first-head cut.

- [ ] **Step 2: Run RED**

Run:

~~~sh
npm run build && node --test test/runrevision-contracts.mjs test/runrevision-store.mjs
~~~

Expected: FAIL because runrevisionstore exports are absent.

- [ ] **Step 3: Implement safe publication and complete reads**

Require a dependency-injected mutation/recovery authority check before every revision/HEAD publication or tail recovery. Use same-directory O_EXCL/O_NOFOLLOW staging, fsync, create-only link, unlink, directory fsync, then HEAD rename/fsync. Stable readers must lstat every existing component, open no-follow regular one-link leaves, charge declared and actual bytes before allocation, compare pre/post descriptor metadata, require canonical bytes, and re-read HEAD/authority identity after chain validation.

Implement streaming bounded enumeration; never sort an unbounded directory or enqueue an entry before charging it. Preserve corrupt files and recognized leftovers in bounded issues; cleanup is restricted to token-owned staging paths supplied by authority.

- [ ] **Step 4: Run GREEN**

Run:

~~~sh
npm run build
node --test test/runrevision-contracts.mjs test/runrevision-store.mjs
npm run test:runreceipt
git diff --check
~~~

Expected: all named tests pass; child-process cuts exit with the asserted classifications.

- [ ] **Step 5: Extend the focused script and commit**

Append test/runrevision-store.mjs to test:runrevision and commit:

~~~text
feat(run): publish immutable revision chains

RED: npm run build && node --test test/runrevision-contracts.mjs test/runrevision-store.mjs (missing store API).
GREEN: npm run build; npm run test:runrevision; npm run test:runreceipt; git diff --check.
Crash fixtures exercise local POSIX process/filesystem cuts with an injected test authority only; Task 4 supplies real owner authority. No power-loss, Windows, or runtime claim.
~~~

---

### Task 3: Physical project locator and target-generation identity

**Files:**
- Create: src/fleetinputidentity.ts
- Create: test/runrevision-locator.mjs
- Modify: package.json

**Interfaces:**
- Produces resolveProjectLocator(requestedProjectsRoot: string, briefId: string): ProjectLocatorV1
- Produces revalidateProjectLocator(locator: ProjectLocatorV1): ProjectLocatorV1
- Produces applicationResourceKey(app: string, serial: "emulator-5554"): string
- Produces projectResourceKey(physicalProjectDir: string): string
- Produces observeTargetGeneration(target: RunTargetV1): TargetGenerationV1
- Produces readCompatibilityBrief(target: RunTargetV1): BriefGenerationV1
- Reuses collectGradleInputIdentity without changing policy pico-native-receipt-gradle-input-v1.

- [ ] **Step 1: Write failing locator/generation tests**

Create existing and absent project fixtures and assert literal requested/physical/anchor/missingSuffix fields. Cover:

- default/custom lexical spellings and two safe aliases resolving to one physical project;
- existing/absent roots, stable deepest-ancestor walk, 64/+1 components and 16 KiB/+1 path bytes;
- symlink components/retarget, ancestor replacement, non-directory/FIFO, outside-root resolution;
- wrong post-scaffold real path, project delete/recreate device/inode drift, and documented same-inode boundary;
- brief absent/observed, exact raw brief and strict canonical payload, oversize/extra-key/malformed/symlink/hard-link/replacement race;
- generation changes for selected Gradle input but not README/build caches;
- V1 never creates, truncates, renames, repairs, or adopts the compatibility brief.

- [ ] **Step 2: Run RED**

Run:

~~~sh
npm run build && node --test test/runrevision-locator.mjs
~~~

Expected: FAIL because fleetinputidentity exports are absent.

- [ ] **Step 3: Implement stable locator and generation observation**

Resolve requested paths with path.resolve, then stably walk to the deepest existing ancestor, recording real path plus decimal-string device/inode and bounded safe missing suffix. Existing projects must be stable directories; absent projects predict one physical path and validate it again after creation. Requested spelling never replaces physical identity.

Read compatibility briefs with bounded stable no-follow reads and appSpecSchema, but return only generation/diagnostics. For projects, bind stable physical directory metadata and collectGradleInputIdentity. Represent an unmeasurable post-attempt project as unobservable; never accept it as another attempt precondition.

- [ ] **Step 4: Run GREEN and existing receipt identity regression**

Run:

~~~sh
npm run build
node --test test/runrevision-locator.mjs
node --test test/runreceipt-identity.mjs
git diff --check
~~~

Expected: all tests pass and receipt policy output remains unchanged.

- [ ] **Step 5: Extend test:runrevision and commit**

Commit:

~~~text
feat(run): bind physical project generations

RED: npm run build && node --test test/runrevision-locator.mjs (missing locator API).
GREEN: npm run build; npm run test:runrevision; node --test test/runreceipt-identity.mjs; git diff --check.
Stable local filesystem fixtures only; no emulator/source restoration or Windows durability claim.
~~~

---

### Task 4: Three-scope owner locks and recovery elections

**Files:**
- Create: src/runlocks.ts
- Create: test/runrevision-locks.mjs
- Create: test/fixtures/runlock-child.mjs
- Modify: src/runrevisionstore.ts
- Modify: package.json

**Interfaces:**
- Produces acquireRunOwners(input: RunOwnerAcquireInputV1, deps: RunLockDependenciesV1): Promise<RunOwnerSetV1>
- Produces acquirePublicFleetOwners(input: PublicFleetOwnerAcquireInputV1, deps: RunLockDependenciesV1): Promise<PublicFleetOwnerSetV1>
- Produces releaseDefiniteOwners(owners: RunOwnerSetV1 | PublicFleetOwnerSetV1, durableAuthority: DurableOwnerReleaseAuthorityV1, deps: RunLockDependenciesV1): Promise<void>
- Produces retainInDoubtOwners(owners: RunOwnerSetV1): RetainedOwnerSetV1
- Produces recoverDeadPrefix(classification: DeadOwnerPrefixClassificationV1, deps: RunLockDependenciesV1): Promise<RecoveryResultV1>
- Produces authorizeRunOwnerRelease(owners: RunOwnerSetV1, chain: CoreRunChainV1): DurableOwnerReleaseAuthorityV1
- Produces authorizePublicFleetOwnerRelease(owners: PublicFleetOwnerSetV1, marker: PublicFleetCompletionMarkerV1): DurableOwnerReleaseAuthorityV1
- Owner capabilities are locally branded and token/path/current-process-identity checked at every mutation.
- Produces createLockBackedRunRevisionStore(lockDeps: RunLockDependenciesV1, storeOptions?: RunStoreOptionsV1): RunRevisionStoreV1, wiring Task 2's required authority callbacks to current owner-file/token validation.
- Defines the lock handoff exactly:

~~~ts
export type RunOwnerAcquireInputV1 = Readonly<{
  runId: LowercaseUuidV4;
  mode: "coordination" | "execution";
  attemptId: LowercaseUuidV4 | null;
  resourceKey: Sha256;
  projectResourceKey: Sha256;
  projectLocator: ProjectLocatorV1;
  deadlineMonotonicMs: number;
}>;
export type PublicFleetOwnerAcquireInputV1 = Readonly<
  Omit<RunOwnerAcquireInputV1, "runId" | "mode"> & {
    runId: null;
    mode: "execution";
    attemptId: LowercaseUuidV4;
  }
>;
export type RunLockDependenciesV1 = Readonly<{
  rootDir: string;
  pid: number;
  processIdentity(): string;
  isProcessIdentityLive(pid: number, identity: string): boolean;
  monotonicMs(): number;
  nowUtc(): CanonicalUtcTimestamp;
  uuid(): LowercaseUuidV4;
}>;
declare const ownerCapabilityBrand: unique symbol;
export type OwnerCapabilityV1<S extends "run" | "application" | "project"> =
  Readonly<{
    scope: S;
    token: LowercaseUuidV4;
    record: RunOwnerRecordV1;
    readonly [ownerCapabilityBrand]: true;
  }>;
export type ApplicationOwnerCapabilityV1 = OwnerCapabilityV1<"application">;
export type RunOwnerSetV1 = Readonly<{
  run: OwnerCapabilityV1<"run">;
  application: ApplicationOwnerCapabilityV1;
  project: OwnerCapabilityV1<"project">;
}>;
export type PublicFleetOwnerSetV1 = Readonly<{
  run: null;
  application: ApplicationOwnerCapabilityV1;
  project: OwnerCapabilityV1<"project">;
}>;
declare const ownerReleaseAuthorityBrand: unique symbol;
export type DurableOwnerReleaseAuthorityV1 = Readonly<{
  kind: "run-head" | "public-fleet-completion";
  runId: LowercaseUuidV4 | null;
  attemptId: LowercaseUuidV4 | null;
  applicationOwnerToken: LowercaseUuidV4;
  projectOwnerToken: LowercaseUuidV4;
  runOwnerToken: LowercaseUuidV4 | null;
  authorityDigest: Sha256;
  readonly [ownerReleaseAuthorityBrand]: true;
}>;
export type DeadOwnerPrefixClassificationV1 =
  | { kind: "run-prefix"; owners:
      | readonly [RunOwnerRecordV1]
      | readonly [RunOwnerRecordV1, RunOwnerRecordV1]
      | readonly [RunOwnerRecordV1, RunOwnerRecordV1, RunOwnerRecordV1];
      chain: CoreRunChainV1 | null;
      classification: "pre-target" | "coordination-head" |
        "definite-outcome-head" | "attempt-in-doubt" | "invalid-store" }
  | { kind: "public-fleet-prefix"; owners:
      | readonly [RunOwnerRecordV1]
      | readonly [RunOwnerRecordV1, RunOwnerRecordV1];
      started: PublicFleetExecutionMarkerV1 | null;
      completed: PublicFleetCompletionMarkerV1 | null;
      classification: "pre-started" | "completed" |
        "interrupted-in-doubt" | "invalid-store" };
~~~

Only the two authorization functions mint DurableOwnerReleaseAuthorityV1 after exact owner-token,
HEAD/attempt, or Task 8 completion-marker validation. DeadOwnerPrefixClassificationV1 contains only
the strict prefixes above plus byte-identical owner records; no suffix shape exists.

- [ ] **Step 1: Write failing same/cross-process lock tests**

Use an injected monotonic clock and process-start probe. Assert:

- run→application→project and public application→project acquisition;
- reverse quarantine after durable coordination or definite outcome;
- one shared 15-second budget, live owner beyond 15 seconds, dead owner, PID reuse, malformed owner, missing process identity;
- only acquisition/release prefixes validate; suffix/skipped-middle/mismatched generations remain invalid-store;
- token-specific elections never touch a replacement generation;
- in-doubt retains all required owners and recovery returns interrupted-in-doubt;
- exact owner/election/quarantine canonical schemas and strict directory-entry bounds;
- SIGKILL after each acquisition and reverse quarantine yields only the documented next classification.

- [ ] **Step 2: Run RED**

Run:

~~~sh
npm run build && node --test test/runrevision-locks.mjs
~~~

Expected: FAIL because runlocks exports are absent.

- [ ] **Step 3: Implement owner generations and store-aware recovery**

Owner files are named token.owner.json and contain strict canonical scope/mode/run/attempt/resource/path/process identity. Quarantine names are lock-path.released.sha256-owner-token.cleanup-token. Recovery elections are distinct create-only directories acquired in global order and released token-checked.

Wire Task 2's mutation/recovery callbacks only after current owner bytes, token, scope, and target agree. A raw linked revision plus staging alias never becomes authority. A linked alias-free tail may advance HEAD under exact elections; attempt-started retains execution owners, while a durable definite outcome permits reverse cleanup. Public started/completed markers are deliberately Task 8 work because they consume Task 6 capabilities and Task 7 validated Fleet observations.

- [ ] **Step 4: Run GREEN**

Run:

~~~sh
npm run build
node --test test/runrevision-contracts.mjs test/runrevision-store.mjs test/runrevision-locks.mjs
git diff --check
~~~

Expected: all parent/child-process cases pass with zero leaked live test processes.

- [ ] **Step 5: Extend test:runrevision and commit**

Commit:

~~~text
feat(run): serialize run application and project owners

RED: npm run build && node --test test/runrevision-locks.mjs (missing lock API).
GREEN: npm run build; npm run test:runrevision; git diff --check.
Measured with injected/local POSIX process identities and SIGKILL fixtures; no network filesystem, power-loss, or Windows claim.
~~~

---

### Task 5: Complete root scan, target admission, and linear lineage

**Files:**
- Modify: src/runrevisionstore.ts
- Create: test/runrevision-lineage.mjs
- Modify: package.json

**Interfaces:**
- Produces scanRunStore(options: RunStoreOptionsV1, coreValidators: RunCoreValidatorsV1, targetValidators: RunTargetValidatorsV1): RunStoreScanResultV1
- Produces assertCompleteRunStoreScanOrigin(result: RunStoreScanResultV1 & { status: "complete" }): CompleteRunStoreScanV1
- Produces classifyTarget(scan: CompleteRunStoreScanV1, locator: ProjectLocatorV1, generation: TargetGenerationV1, intent: NormalizedRunIntentV1): TargetClassificationV1
- Produces prepareNewTargetAdmission(data: NewRunAdmissionDataV1, classification: TargetClassificationV1 & { status: "new" }, owners: RunOwnerSetV1): NewRunAdmissionCandidateV1
- Produces prepareReceiptFreeChildAdmission(data: NewRunAdmissionDataV1, base: TargetBaseV1, classification: TargetClassificationV1 & { status: "occupied-receipt-free" }, owners: RunOwnerSetV1): NewRunAdmissionCandidateV1
- Produces admitNewRun(candidate: NewRunAdmissionCandidateV1, owners: RunOwnerSetV1, store: RunRevisionStoreV1): ValidatedRunChainV1
- Produces assertValidatedRunChainOrigin(chain: ValidatedRunChainV1): void
- Produces assertTargetClassificationOrigin(classification: TargetClassificationV1): void
- Produces selectUniqueResourceLeaf(scan: CompleteRunStoreScanV1, resourceKey: Sha256, projectResourceKey: Sha256): ResourceLeafSelectionV1
- Defines exact scan/classification aliases:

~~~ts
export type RunTargetValidatorsV1 = Readonly<{
  revalidateLocator(locator: ProjectLocatorV1): ProjectLocatorV1;
  observeGeneration(target: RunTargetV1): TargetGenerationV1;
  applicationKey(app: string, serial: "emulator-5554"): Sha256;
  projectKey(physicalProjectDir: string): Sha256;
}>;
export type NewRunAdmissionDataV1 = Readonly<{
  intent: NormalizedRunIntentV1;
  target: RunTargetV1;
}>;
declare const newRunAdmissionBrand: unique symbol;
export type NewRunAdmissionCandidateV1 = Readonly<{
  mode: "new" | "receipt-free-base" | "projection-validated-base";
  data: NewRunAdmissionDataV1;
  ownerTokens: {
    run: LowercaseUuidV4;
    application: LowercaseUuidV4;
    project: LowercaseUuidV4;
  };
  predecessor: TargetBaseV1 | null;
  observedGeneration: TargetGenerationV1;
  readonly [newRunAdmissionBrand]: true;
}>;
declare const validatedRunChainBrand: unique symbol;
export type ValidatedRunChainV1 = Readonly<{
  core: CoreRunChainV1;
  locator: ProjectLocatorV1;
  lineage: {
    base: TargetBaseV1 | null;
    child: { runId: LowercaseUuidV4; revision: number; revisionId: Sha256 } | null;
    acyclic: true;
    singleChild: true;
  };
  validation: "core-target-lineage";
  readonly [validatedRunChainBrand]: true;
}>;
declare const completeRunStoreScanBrand: unique symbol;
declare const completeRunStoreScanResultBrand: unique symbol;
export type CompleteRunStoreScanV1 = Readonly<{
  runs: readonly ValidatedRunChainV1[];
  invalidCandidates: readonly BoundedDiagnosticV1[];
  unknownPresence: boolean;
  rootEntryCount: number;
  aggregate: {
    nestedEntries: number;
    revisions: number;
    objects: number;
    canonicalBytes: number;
  };
  readonly [completeRunStoreScanBrand]: true;
}>;
export type RunStoreScanResultV1 =
  | { status: "complete"; scan: CompleteRunStoreScanV1;
      readonly [completeRunStoreScanResultBrand]: true }
  | { status: "invalid-store";
      result: RunControlResultV1 & { status: "invalid-store" } }
  | { status: "limit-exceeded";
      result: RunControlResultV1 & { status: "limit-exceeded" } };
declare const targetClassificationBrand: unique symbol;
export type TargetClassificationV1 =
  | { status: "new"; locator: ProjectLocatorV1; generation: TargetGenerationV1;
      readonly [targetClassificationBrand]: true }
  | { status: "occupied-receipt-free"; locator: ProjectLocatorV1;
      generation: TargetGenerationV1; leaf: ValidatedRunChainV1;
      readonly [targetClassificationBrand]: true }
  | { status: "occupied-projection-required"; locator: ProjectLocatorV1;
      generation: TargetGenerationV1; leaf: ValidatedRunChainV1;
      readonly [targetClassificationBrand]: true }
  | { status: "occupied-ineligible"; locator: ProjectLocatorV1;
      generation: TargetGenerationV1; leaf: ValidatedRunChainV1 | null;
      result: RunControlResultV1 & { status: "target-conflict" } }
  | { status: "target-conflict";
      result: RunControlResultV1 & { status: "target-conflict" } }
  | { status: "invalid-store";
      result: RunControlResultV1 & { status: "invalid-store" } }
  | { status: "limit-exceeded";
      result: RunControlResultV1 & { status: "limit-exceeded" } };
export type ResourceLeafSelectionV1 =
  | { status: "none" }
  | { status: "unique-receipt-free"; chain: ValidatedRunChainV1 }
  | { status: "projection-required"; chain: ValidatedRunChainV1 }
  | { status: "ambiguous" | "invalid"; issues: readonly BoundedDiagnosticV1[] };
~~~

ValidatedRunChainV1, CompleteRunStoreScanV1, and each admission-capable TargetClassificationV1 arm
are nominal at runtime: scanRunStore/classifyTarget register their exact identities in private
WeakSets, and classification requires a registered complete scan whose chains remain registered.
The complete RunStoreScanResultV1 wrapper has its own private identity registration;
assertCompleteRunStoreScanOrigin requires both exact registered wrapper and scan identities and
returns only that scan. A
scan ceiling/safety failure returns only the typed failure arm—never a partial
CompleteRunStoreScanV1. The preparation functions require the registered classification identity as
well as matching current owners/generation. NewRunAdmissionCandidateV1 is likewise nominal:
runrevisionstore.ts keeps a private WeakSet of candidates and admitNewRun requires exact registered
object identity. These brand symbols, registries, and the low-level issuer are not exported. Task 9
adds its projected preparation route in this same module only after runprojection.ts's narrow origin
assertion has validated and single-use-consumed the exact projected eligibility. Cloning or
reconstructing any visible chain/scan/classification/candidate/eligibility fields therefore cannot
publish a child or become projection authority.

- [ ] **Step 1: Write failing admission and lineage tests**

Use injected UUIDs and exact resource fixtures. Cover:

- a genuinely new target and four UUID collision/reservation attempts;
- occupied compatibility brief, project, application lineage, or physical-project lineage without targetBase;
- exact terminal HEAD base, stale/wrong/non-HEAD base, raw byte-different but normalized-equal brief, and pre-V1 legacy target;
- terminal generation closure from one definite attributed attempt or a no-attempt zero-budget path;
- no branch, cycle, duplicate child, non-leaf, consumed base, or concurrent second child;
- zero-attempt, receipt-free terminal base admitted once; any evidence-bearing terminal is returned as projection-required and cannot be consumed until Task 9 adds exact receipt/auto authority classification;
- child revision zero inherits exact current generation/input base/resource keys but no receipt, auto-event, compiler, attempt input, result, or evidence;
- corrupt/unknown/root staging/canonical-UUID file or symlink suppresses legacy fallback;
- root/CAS/revision/lock aggregate exact/+1 limits, especially a 4,097th reserved, malformed, staging, unsafe, or valid root entry;
- each +1/safety scan failure exposes only RunStoreScanResultV1's failure arm; a partial or cloned
  scan and caller-shaped new/occupied classification cannot reach selection or admission;
- shallow/deep clones or caller-shaped complete-result wrappers fail
  assertCompleteRunStoreScanOrigin and cannot enable classification or legacy fallback;
- two different apps with one physical-project key conflict even after an earlier owner releases.

- [ ] **Step 2: Run RED**

Run:

~~~sh
npm run build && node --test test/runrevision-lineage.mjs
~~~

Expected: FAIL because admission/lineage exports are absent.

- [ ] **Step 3: Implement complete scans and single-use target bases**

Stream every root/namespace directory and charge before storing/sorting. On a ceiling or safety
failure, return only RunStoreScanResultV1's typed failure and discard any in-progress scan authority.
Read each candidate first
as CoreRunChainV1, then use Task 3's RunTargetValidatorsV1 to revalidate the stored physical locator,
rederive both resource keys, and validate the complete base/child lineage before promoting it to
ValidatedRunChainV1. Defer only receipt/ledger projection work to the selected run. Reserved
directories count but are not candidates; any other unknown/unsafe entry is disclosed V1 presence.

Admission runs only under application/project owners, then under run→application→project for
publication. Require exact target.briefInput bytes, identical application/project keys and physical
directory, closed expected generation, no retained execution owner, one acyclic lineage, and zero
existing child. The two Task 5 preparation functions validate the complete NewRunAdmissionDataV1,
bind the current three owner tokens, and mint the private candidate; admitNewRun revalidates those
tokens and accepts no raw intent/target/classification tuple. Revision zero publishes the
candidate's caller-normalized goal/spec/acceptance/policy and exact raw brief/app/input-base/paths/
locator/resource keys/base coordinate—not the predecessor's intent. In this task, prepare only a
genuinely new target or receipt-free terminal child. Return a typed projection-required selection
for every evidence-bearing terminal without creating a candidate. Task 9 adds the third preparation
route after proving that any broken state is confined to receipt/auto projection. Publish exactly
one base edge in revision zero.

- [ ] **Step 4: Run GREEN**

Run:

~~~sh
npm run build
node --test test/runrevision-contracts.mjs test/runrevision-store.mjs test/runrevision-locator.mjs test/runrevision-locks.mjs test/runrevision-lineage.mjs
git diff --check
~~~

Expected: every admission/concurrency fixture passes and partial scans never select a target.

- [ ] **Step 5: Extend test:runrevision and commit**

Commit:

~~~text
feat(run): admit linear target lineages

RED: npm run build && node --test test/runrevision-lineage.mjs (missing lineage API).
GREEN: npm run build; npm run test:runrevision; git diff --check.
Hermetic target generations only; no mutable target adoption, runtime restoration, or evidence inheritance claim.
~~~

---

### Task 6: Attempt-bound external manifests and sealed capabilities

**Files:**
- Modify: src/fleetinputidentity.ts
- Create: test/runrevision-inputs.mjs
- Modify: package.json

**Interfaces:**
- Produces collectExternalInputManifest(spec: AppSpec, target: RunTargetV1, generation: TargetGenerationV1, options: ExternalInputCollectionOptionsV1): CollectedExternalInputsV1
- Produces materializeSealedInputView(collected: CollectedExternalInputsV1, ownerToken: LowercaseUuidV4, attemptId: LowercaseUuidV4, options: SealedViewOptionsV1): FleetSealedInputViewV1
- Produces createFleetExecutionInputsCapability(input: FleetExecutionCapabilityInputV1): FleetExecutionInputsCapabilityV1
- Produces createLegacyFleetExecutionCapability(input: LegacyFleetCapabilityInputV1): LegacyFleetExecutionCapabilityV1
- Produces validateSealedConsumption(capability: FleetExecutionInputsCapabilityV1): ValidatedSealedConsumptionV1
- Produces cleanupSealedInputView(view: FleetSealedInputViewV1, authority: ApplicationOwnerCapabilityV1): void
- Defines every handoff exactly:

~~~ts
export type ExternalInputCollectionOptionsV1 = Readonly<{
  inputBaseDir: string;
  canonicalHomeDir: string;
  userBriefDir: string;
  corpusBriefsDir: string;
  projectDir: string;
}>;
export type SealedViewOptionsV1 = Readonly<{
  runStoreRoot: string;
  applicationOwner: ApplicationOwnerCapabilityV1;
}>;
export type StableExternalDescriptorV1 = Readonly<{
  fileIndex: number;
  resolvedPath: string;
  realPath: string;
  bytes: number;
  sha256: Sha256;
  descriptor: number;
}>;
export type CollectedExternalInputsV1 = Readonly<{
  snapshot: ExternalInputSnapshotV1;
  descriptors: readonly StableExternalDescriptorV1[];
}>;
export type ValidatedSealedConsumptionV1 = Readonly<{
  manifestSha256: Sha256;
  consumedFileIndices: readonly number[];
  allConsumedBytesIntact: true;
}>;
export type FleetExecutionCapabilityInputV1 = Readonly<{
  mode: "run-payload" | "v1-backed-fleet";
  app: string;
  serial: "emulator-5554";
  resourceKey: Sha256;
  projectResourceKey: Sha256;
  projectLocator: ProjectLocatorV1;
  inputBaseDir: string;
  runOwner: OwnerCapabilityV1<"run"> | null;
  applicationOwner: ApplicationOwnerCapabilityV1;
  projectOwner: OwnerCapabilityV1<"project">;
  attemptId: LowercaseUuidV4;
  briefPayloadSha256: Sha256;
  externalInputRef: SnapshotRefV1 & { kind: "external-input" };
  externalInput: ExternalInputSnapshotV1;
  sealedView: FleetSealedInputViewV1;
}>;
export type LegacyFleetCapabilityInputV1 = Readonly<{
  app: string;
  serial: "emulator-5554";
  resourceKey: Sha256;
  projectResourceKey: Sha256;
  projectLocator: ProjectLocatorV1;
  applicationOwner: ApplicationOwnerCapabilityV1;
  projectOwner: OwnerCapabilityV1<"project">;
  attemptId: LowercaseUuidV4;
  briefPath: string;
  assetBaseDir: string;
  briefPayloadSha256: Sha256;
  briefPayload: { id: string; brief: string; spec: AppSpec };
}>;
~~~

Descriptor order matches snapshot.files. A run-payload capability requires non-null runOwner;
V1-backed Fleet requires null; the factory enforces that cross-field rule.

- [ ] **Step 1: Write failing manifest, closure, race, and bound tests**

Build literal AppSpecs covering semantic scene, occupancy, textured environment, splat, pano, seat model, model sidecars, and IBL. Assert:

- uses preserve AppSpec order/duplicates; files hash once and sort by canonical resolved path;
- GLTF dependencies follow buffer then image array order, safe percent-decoded relative paths work, inline data stays self-contained, and scheme/scheme-relative/absolute/backslash/query/fragment/traversal forms reject;
- bounded self-contained GLB succeeds and loose USD/USDA/USDC rejects;
- user IBL directory safely present selects user; absence selects corpus; unsafe user entry fails; selected-user missing KTX does not fall through; safe project destination binds matching generation;
- missing/edited/deleted/newly appeared/symlink/hard-link/FIFO/directory/component-symlink and lstat/open/mid-hash/post-hash replacements classify exactly;
- 256/+1 uses/files, 16 KiB/+1 paths, per-kind exact/+1 bytes, JSON depth 32/+1, and 2 GiB aggregate charge before stream/allocation;
- every observed source copies from retained descriptors, copies independently rehash, originals close before attempt publication, files become read-only, directories become non-writable;
- original path mutation after sealing cannot change current capability; sealed-copy tamper invalidates completion; a repaired next attempt produces another manifest ref;
- proven no-lineage legacy capability performs none of V1 manifest/closure/2-GiB work.

- [ ] **Step 2: Run RED**

Run:

~~~sh
npm run build && node --test test/runrevision-inputs.mjs
~~~

Expected: FAIL because external-input and capability exports are absent.

- [ ] **Step 3: Implement stable collection and sealed views**

Extract paths only from the approved AppSpec roles. Open regular one-link leaves with O_NOFOLLOW, charge descriptor size, hash through a fixed buffer, compare fstat before/after, and require the path still names that descriptor. Retain descriptors until read-only copies under runs/staging/fleet-inputs/owner-attempt validate.

Capabilities are nominal in-process objects retained in private identity sets. Visible fields alone cannot recreate them. Run-payload requires current run/application/project owners; V1-backed public Fleet requires application/project and null run token; legacy uses its distinct accepted mutable resolver. Every consumer resolves only sealed copies.

- [ ] **Step 4: Run GREEN**

Run:

~~~sh
npm run build
node --test test/runrevision-inputs.mjs test/runrevision-locator.mjs
npm run test:runreceipt
git diff --check
~~~

Expected: all manifest/capability tests pass and receipt tests remain unchanged.

- [ ] **Step 5: Extend test:runrevision and commit**

Commit:

~~~text
feat(run): seal attempt external inputs

RED: npm run build && node --test test/runrevision-inputs.mjs (missing manifest/capability API).
GREEN: npm run build; npm run test:runrevision; npm run test:runreceipt; git diff --check.
File fixtures prove structural input binding only; no content appearance, runtime, or visual claim.
~~~

---

### Task 7: Fleet execution core, compiler/write attribution, and native dispositions

**Files:**
- Modify: src/fleetbuild.ts
- Modify: src/nativefleetreceipt.ts
- Modify: test/fleetreceipt.mjs
- Modify: test/nativefleetreceipt.mjs
- Create: test/fleetexecution.mjs
- Modify: package.json

**Interfaces:**
- Produces executeFleetBuild(capability: FleetCoreCapabilityV1, deps: FleetExecutionDependenciesV1): Promise<ValidatedFleetExecutionV1>
- Native producer returns the approved additive recorded | failed | in-doubt union while preserving every existing recorded/failed field.
- The core receives no runId and never writes a revision.
- Produces one origin-bound result that later tasks require:

~~~ts
declare const validatedFleetExecutionBrand: unique symbol;
export type ValidatedFleetExecutionV1 = Readonly<{
  envelope: FleetExecutionEnvelopeV1;
  sealedConsumption: ValidatedSealedConsumptionV1 | null;
  writeSetValidated: true;
  receiptValidated: true;
  readonly [validatedFleetExecutionBrand]: true;
}>;
export type FleetExecutionDependenciesV1 = Readonly<{
  assertCapabilityCurrent(capability: FleetCoreCapabilityV1): void;
  resolveInput(capability: FleetCoreCapabilityV1, useIndex: number): string;
  callInner(name: string, args: JsonObject):
    Promise<ExternalPhaseCallResultV1<JsonValue>>;
  writeProjectFile(input: {
    projectDir: string;
    relativePath: string;
    bytes: Uint8Array;
    origin: ProjectWriteRecordV1["origin"];
    stepOrder: number | null;
  }): Promise<ExternalPhaseCallResultV1<ProjectWriteRecordV1>>;
  runNative(input: ProduceNativeFleetReceiptInput):
    Promise<NativeFleetExecutionResultV1>;
  validateHistoricalReceipt(
    app: string,
    receiptId: Sha256,
  ): NativeRunReceiptValidation;
  monotonicMs(): number;
}>;
declare const fleetLocalExecutionTraceBrand: unique symbol;
type FleetLocalExecutionTraceV1 = Readonly<{
  capability: FleetCoreCapabilityV1;
  phases: readonly {
    phase: ExternalPhaseV1 | "complete";
    disposition: "definitely-completed" | "in-doubt";
    externalMutationDisposition: "none" | "possible" | "confirmed";
  }[];
  compilerLedger: CompilerLedgerSnapshotV1 | null;
  projectWrites: readonly ProjectWriteRecordV1[];
  sealedConsumption: ValidatedSealedConsumptionV1 | null;
  receiptValidation: NativeRunReceiptValidation | null;
  readonly [fleetLocalExecutionTraceBrand]: true;
}>;
~~~

FleetLocalExecutionTraceV1 and normalizeFleetExecutionEnvelope are module-private implementation
details, are not exported, and are reachable only inside executeFleetBuild. The live executor mints
each trace with a private unique-symbol brand and registers its object identity in a private WeakSet;
the normalizer requires that exact registered trace and the identical live capability. Passing a
plain capability plus a caller-shaped, cloned, serialized, or independently parsed trace is not a
public call path and cannot mint ValidatedFleetExecutionV1. Only executeFleetBuild may mint the
exported result after strict parsing, local phase-trace identity, current-owner checks, independent
write-set/generation validation, sealed-consumption validation, and receipt validation. A serialized,
cloned, caller-shaped, or independently parsed FleetExecutionEnvelopeV1 cannot populate run state,
public completion authority, compiler state, or receipt refs.
executeFleetBuild also registers every ValidatedFleetExecutionV1 result identity in a second private
WeakSet. Task 8's completion publisher lives in the same module and requires membership plus current
capability/owner checks; copying the result, not just its envelope, loses completion authority.

- [ ] **Step 1: Write failing extraction/disposition tests**

Drive real core logic with injected local phase functions. Cover:

- locally branded run-payload, V1-backed, and legacy capabilities; cloned/forged/stale/wrong-token/path/resource capabilities make zero phase calls;
- serialized/reparsed/cloned Fleet envelopes cannot become ValidatedFleetExecutionV1 or populate a run/public completion marker;
- exact pre/post-package-rewrite compiler plan, scaffolded/reused-project, executed/native success/failure, not-attempted/in-doubt, confirmed/unconfirmed/not-applicable;
- complete ordered ProjectWriteRecord chains, repeated writes, net restoration retained as auditable, hidden/extra/missing writes and broken intermediate hashes reject;
- definite phase mapping and external mutation none→possible→confirmed monotonic accumulation;
- timeout/disconnect/unconfirmed process-tree termination remains in-doubt;
- pre-receipt ambiguity carries compiler in-doubt and no receipt; post-receipt ambiguity retains only independently validated receipt plus compiler succeeded;
- impossible compiler/result/receipt/phase combinations reject;
- native accepted recorded/failed base fields stay deep-equal, while additive diagnostics/stage mappings appear;
- receipt-bearing after-generation equals the receipt's unchanged Gradle-input identity.

- [ ] **Step 2: Run RED**

Run:

~~~sh
npm run build && node --test test/fleetexecution.mjs test/nativefleetreceipt.mjs test/fleetreceipt.mjs
~~~

Expected: FAIL because executeFleetBuild/disposition APIs are absent.

- [ ] **Step 3: Extract and minimally adapt existing Fleet behavior**

Move the per-brief body out of MCP registration without reordering accepted phases. Construct the post-rewrite plan before the first project mutation. Instrument only approved write seams and capture before/after identities for selected project inputs. Normalize optional public fields to the strict private FleetResultV1; the public wrapper later removes compatibility nulls. Return the locally branded ValidatedFleetExecutionV1, not the plain envelope.

Map native source/build/APK to native-build; install/installed bytes to install; after-install delivery to asset-delivery; launch/device/PID/foreground to launch; capture materialization to capture; receipt publication to receipt-publication. Do not change receipt v1 schema or infer completion from booleans/notes.

- [ ] **Step 4: Run GREEN and Fleet regressions**

Run:

~~~sh
npm run build
node --test test/fleetexecution.mjs test/nativefleetreceipt.mjs test/fleetreceipt.mjs
npm run test:runreceipt
git diff --check
~~~

Expected: all focused tests pass and existing Fleet receipt public shapes remain compatible.

- [ ] **Step 5: Extend test:runrevision and commit**

Commit:

~~~text
refactor(run): expose capability-bound Fleet execution

RED: npm run build && node --test test/fleetexecution.mjs test/nativefleetreceipt.mjs test/fleetreceipt.mjs (missing core/dispositions).
GREEN: npm run build; npm run test:runrevision; npm run test:runreceipt; git diff --check.
Injected runner outcomes only; no live Gradle, adb, emulator, Windows, Swan, hardware, or LOOK claim.
~~~

---

### Task 8: Public fleet_build coordination and compatibility routing

**Files:**
- Modify: src/fleetbuild.ts
- Create: test/fleetcoordination.mjs
- Create: test/fixtures/fleetcoordination-child.mjs
- Modify: package.json

**Interfaces:**
- Public fleet_build retains current request/result shapes for normal records.
- Coordination failures add only coordinationStatus and coordinationContinuation.
- Consumes Task 5's non-injectable assertCompleteRunStoreScanOrigin before any complete-arm use.
- Produces resolvePublicFleetInput(id: string, projectsRoot: string, scanResult: RunStoreScanResultV1, owners: PublicFleetOwnerSetV1, deps: PublicFleetCoordinationDependenciesV1): PublicFleetInputResolutionV1
- Produces executeCoordinatedPublicFleetBrief(input: PublicFleetInputResolutionV1, deps: PublicFleetCoordinationDependenciesV1): Promise<FleetPublicRecordV1>
- Produces publishPublicFleetStarted(owners: PublicFleetOwnerSetV1, capability: FleetCoreCapabilityV1, deps: PublicFleetCoordinationDependenciesV1): PublicFleetExecutionMarkerV1
- Produces publishPublicFleetCompleted(owners: PublicFleetOwnerSetV1, execution: ValidatedFleetExecutionV1, deps: PublicFleetCoordinationDependenciesV1): PublicFleetCompletionMarkerV1
- Produces projectLegacyFleetResult(result: FleetResultV1): FleetLegacyCompatibleRecordV1 with the exact accepted public optional-field omission rules.
- Defines FleetPublicRecordV1 as FleetLegacyCompatibleRecordV1 or this exact failure-only arm:

~~~ts
export type FleetCoordinationFailureRecordV1 = Readonly<{
  id: string;
  built: false;
  installed: false;
  concluded: false;
  verdict: null;
  artifact: null;
  receipt: null;
  verificationRoute: null;
  panelEvidence: null;
  panelArtifact: null;
  notes: [string];
  coordinationStatus:
    | "run-busy" | "interrupted-in-doubt" | "target-conflict"
    | "external-state-conflict" | "recovery-required"
    | "invalid-store" | "limit-exceeded" | "state-write-failed";
  coordinationContinuation: null | {
    tool: "pico_build_app" | "pico_loop";
    arguments: { runId: LowercaseUuidV4; expectedRevision: number };
  };
}>;
export type FleetPublicRecordV1 =
  | FleetLegacyCompatibleRecordV1
  | FleetCoordinationFailureRecordV1;
export type PublicFleetInputResolutionV1 =
  | { status: "ready"; mode: "v1-backed-fleet";
      owners: PublicFleetOwnerSetV1;
      capability: FleetExecutionInputsCapabilityV1 }
  | { status: "ready"; mode: "legacy-fleet";
      owners: PublicFleetOwnerSetV1;
      capability: LegacyFleetExecutionCapabilityV1 }
  | { status: "failure"; owners: PublicFleetOwnerSetV1 | null;
      record: FleetCoordinationFailureRecordV1 };
export type PublicFleetCoordinationDependenciesV1 = Readonly<{
  storeOptions: RunStoreOptionsV1;
  coreValidators: RunCoreValidatorsV1;
  targetValidators: RunTargetValidatorsV1;
  lockDeps: RunLockDependenciesV1;
  scan: typeof scanRunStore;
  acquireOwners: typeof acquirePublicFleetOwners;
  collectInputs: typeof collectExternalInputManifest;
  sealInputs: typeof materializeSealedInputView;
  createSealedCapability: typeof createFleetExecutionInputsCapability;
  createLegacyCapability: typeof createLegacyFleetExecutionCapability;
  execute: typeof executeFleetBuild;
  releaseOwners: typeof releaseDefiniteOwners;
}>;
~~~

FleetLegacyCompatibleRecordV1 is exact:

~~~ts
export type FleetLegacyCompatibleRecordV1 = Readonly<{
  id: string;
  built: boolean;
  installed: boolean;
  concluded: boolean;
  verdict: string | null;
  artifact: string | null;
  receipt: FleetReceiptSummaryV1 | null;
  verificationRoute: JsonValue | null;
  panelEvidence: JsonValue | null;
  panelArtifact: string | null;
  notes: string[];
  visualExpectation?: JsonValue;
  visualClaim?: string | null;
  splatAssets?: JsonValue;
  confidence?: number;
  visualChecks?: JsonValue[];
  visualJudgeNote?: string | null;
  visualLedger?: JsonValue | null;
  visualJudgeArtifact?: string | null;
  nativeFailure?: FleetResultV1["nativeFailure"];
  externalImplementation?: JsonValue;
}>;
~~~

projectLegacyFleetResult preserves those current omission/presence rules. The failure arm keeps
every initialized field, adds coordination metadata, and cannot silently drop a legacy null field.

- [ ] **Step 1: Write failing wrapper coordination tests**

Cover:

- every brief takes application/project owners and executes serially;
- complete scan proves either one eligible terminal V1 leaf or no lineage on both resource dimensions before mutable resolution;
- invalid-store/limit-exceeded scan arms project directly to the matching coordination failure with
  zero classification, mutable legacy fallback, manifest, marker, or core call;
- shallow/deep cloned or caller-shaped complete scan results fail the Task 5 origin assertion and
  cannot authorize V1 selection or the absence-of-lineage legacy fallback;
- eligible V1 leaf uses immutable brief payload, fresh sealed manifest, physical locator/generation, and no user-brief dependency;
- open/paused leaf returns target-conflict plus exact Door/run/expectedRevision continuation with zero manifest/marker/core call;
- awaiting-authoring, plan-failed, running/in-doubt/blocked, superseded spec, corrupt/ambiguous lineage, generation mismatch, and genuinely different root reject;
- stable alias of the same physical project succeeds; another app owning that physical project suppresses legacy fallback;
- clean no-lineage legacy route preserves user-then-corpus lookup, custom lexical root, missing/invalid handling, mutable model resolution, and no V1 closure/size cap;
- same ID across roots and different IDs aliasing one project never overlap;
- started/completed marker publication crash cuts and project/application reverse cleanup;
- completion publication accepts only Task 7's live ValidatedFleetExecutionV1; serialized, cloned, or caller-shaped envelopes cannot mint completion authority;
- busy/in-doubt failures set built/installed/concluded false, null artifact/receipt/verdict, one bounded matching note, and no ordinary record gains coordination fields.

- [ ] **Step 2: Run RED**

Run:

~~~sh
npm run build && node --test test/fleetcoordination.mjs
~~~

Expected: FAIL because the wrapper has no run-store coordination/resolution API.

- [ ] **Step 3: Implement public selection, markers, and compatibility projection**

Perform stable brief preflight read-only, then branch on RunStoreScanResultV1 under
application/project owners before publishing a marker or resolving mutable assets. Propagate a scan
failure directly; call Task 5's exported WeakSet-backed assertion directly (not an injected
substitute), and only its returned registered complete scan may enter classification. V1-backed Fleet uses the
selected leaf's immutable payload plus one fresh sealed manifest; no-lineage Fleet uses only
LegacyFleetExecutionCapabilityV1.

Publish EXECUTION_STARTED.json before core work and EXECUTION_COMPLETED.json only after every possibly ambiguous wrapper phase returns definitely and Task 7's origin-bound ValidatedFleetExecutionV1 remains current. Hash its strict envelope into the marker. Retain owners for in-doubt/malformed states. Project owner quarantines before application; application-only cleanup requires exact completed-marker witness.

- [ ] **Step 4: Run GREEN and public regression tests**

Run:

~~~sh
npm run build
node --test test/fleetcoordination.mjs test/fleetexecution.mjs test/fleetreceipt.mjs
npm run test:doors
git diff --check
~~~

Expected: all coordination and accepted public Fleet/Door fixtures pass.

- [ ] **Step 5: Extend test:runrevision and commit**

Commit:

~~~text
feat(run): coordinate public Fleet writers

RED: npm run build && node --test test/fleetcoordination.mjs (public wrapper lacked run coordination).
GREEN: npm run build; npm run test:runrevision; npm run test:doors; git diff --check.
Hermetic coordination/legacy fixtures only; no live native, Windows, Swan, hardware, or rendered claim.
~~~

---

### Task 9: Receipt and auto-judge revalidation, projection, and safe replay

**Files:**
- Create: src/runprojection.ts
- Modify: src/runrevisionstore.ts
- Modify: src/ledger.ts
- Create: test/runrevision-projection.mjs
- Modify: package.json

**Interfaces:**
- Produces validateNativeReceiptRef(ref: NativeReceiptRefV1, receiptValidator: HistoricalReceiptValidatorV1, budgets: ProjectionBudgetsV1): ValidatedNativeReceiptCapabilityV1
- Produces resolveAutoJudgeEvent(ref: AutoJudgeEventRefV1, receipt: ValidatedNativeReceiptCapabilityV1, options: AutoJudgeResolverOptionsV1, budgets: ProjectionBudgetsV1): ValidatedAutoJudgeEventCapabilityV1
- Produces assertValidatedAutoJudgeEventOrigin(event: ValidatedAutoJudgeEventCapabilityV1): void
- Produces projectRun(chain: ValidatedRunChainV1, receiptValidator: HistoricalReceiptValidatorV1 | null, autoJudgeValidator: AutoJudgeValidatorV1 | null, budgets: ProjectionBudgetsV1): RunProjectionV1
- Produces replayProjectedResult(projection: RunProjectionV1): ReplayResultV1
- Produces validateProjectedTargetBase(base: TargetBaseV1, projection: RunProjectionV1, classification: TargetClassificationV1 & { status: "occupied-projection-required" }, owners: RunOwnerSetV1): ProjectedTargetBaseEligibilityV1
- Consumes Task 5's non-injectable assertTargetClassificationOrigin before the projection-required classification can authorize eligibility.
- Produces assertAndConsumeProjectedTargetBaseEligibility(eligibility: ProjectedTargetBaseEligibilityV1 & { status: "eligible" }): void as the narrow internal handoff used by prepareProjectedChildAdmission
- Produces prepareProjectedChildAdmission(data: NewRunAdmissionDataV1, eligibility: ProjectedTargetBaseEligibilityV1 & { status: "eligible" }, owners: RunOwnerSetV1): NewRunAdmissionCandidateV1
- Supports exact, authority-stripped, auto-downgraded, and provenance-broken projections only.
- Defines the handoff exactly:

~~~ts
declare const runProjectionBrand: unique symbol;
declare const projectedTargetBaseBrand: unique symbol;
declare const validatedNativeReceiptBrand: unique symbol;
declare const validatedAutoJudgeEventBrand: unique symbol;
export type ValidatedNativeReceiptCapabilityV1 = Readonly<{
  ref: NativeReceiptRefV1;
  validation: Extract<NativeRunReceiptValidation, { status: "valid" }>;
  readonly [validatedNativeReceiptBrand]: true;
}>;
export type ValidatedAutoJudgeEventCapabilityV1 = Readonly<{
  ref: AutoJudgeEventRefV1;
  authoritativeEventDigest: Sha256;
  readonly [validatedAutoJudgeEventBrand]: true;
}>;
export type RunProjectionV1 = Readonly<{
  chain: ValidatedRunChainV1;
  metadata: RunProjectionMetadataV1;
  replay: ReplayResultV1 | null;
  readonly [runProjectionBrand]: true;
}>;
export type ProjectedTargetBaseEligibilityV1 =
  | { status: "eligible"; base: TargetBaseV1;
      evidenceInheritance: "none"; generation: TargetGenerationV1;
      ownerTokens: {
        run: LowercaseUuidV4;
        application: LowercaseUuidV4;
        project: LowercaseUuidV4;
      };
      readonly [projectedTargetBaseBrand]: true }
  | { status: "target-conflict";
      result: RunControlResultV1 & { status: "target-conflict" } }
  | { status: "invalid-store";
      result: RunControlResultV1 & { status: "invalid-store" } }
  | { status: "limit-exceeded";
      result: RunControlResultV1 & { status: "limit-exceeded" } };
~~~

The projection dependencies are exact:

~~~ts
export type HistoricalReceiptValidatorV1 = (
  app: string,
  receiptId: Sha256,
) => NativeRunReceiptValidation;
export type AutoJudgeResolverOptionsV1 = Readonly<{
  ledgerRoot: string;
  maxLedgerBytes: 8388608;
  maxLedgerEvents: 4096;
  maxEventBytes: 65536;
  maxEventDepth: 32;
}>;
export type AutoJudgeValidatorV1 = (
  ref: AutoJudgeEventRefV1,
  receipt: ValidatedNativeReceiptCapabilityV1,
  budgets: ProjectionBudgetsV1,
) => ValidatedAutoJudgeEventCapabilityV1;
export type ProjectionBudgetsV1 = {
  remainingReceiptValidations: number;
  remainingAutoJudgeValidations: number;
  remainingArtifactBytes: number;
  remainingLedgerBytes: number;
  maxIssues: 64;
};
~~~

Initial projection budgets are exactly 64 receipt validations, 64 auto-judge validations, 2 GiB
artifact bytes, 64 MiB ledger bytes, and 64 returned issues. The same mutable budget object is
decremented before opening/hashing so nested validators cannot reset a ceiling.
projectRun first calls Task 5's WeakSet-backed assertValidatedRunChainOrigin and rejects a
caller-shaped/cloned chain before any receipt or ledger read. Only projectRun mints RunProjectionV1
after current core and external authority validation, registers the exact projection identity in a
private runprojection.ts WeakSet, and replayProjectedResult/validateProjectedTargetBase require that
membership. validateProjectedTargetBase alone mints and registers an eligible target-base capability
after calling Task 5's exported WeakSet-backed assertTargetClassificationOrigin directly (not an
injected substitute) and matching that exact occupied-projection-required classification's leaf, coordinate,
core generation, lineage, owner, and registered projection. Its narrow
assertAndConsumeProjectedTargetBaseEligibility checks that private registry and deletes the exact
identity once; runrevisionstore.ts calls it immediately before its private candidate issuer.
validateNativeReceiptRef and resolveAutoJudgeEvent register exact receipt and event capability
identities in separate private ledger.ts WeakSets. The resolver rejects an unregistered receipt
before opening the ledger; projectRun calls the ledger-owned assertValidatedAutoJudgeEventOrigin on
every injected validator result before it can affect evidence. Brand symbols and registries are not
exported, so reflected symbols, casts, clones, and caller-shaped visible fields fail closed.
prepareProjectedChildAdmission accepts the child's complete NewRunAdmissionDataV1, revalidates the
eligibility's exact owner tokens and generation, and uses Task 5's private candidate issuer to mint
a projection-validated-base NewRunAdmissionCandidateV1. Task 5's admitNewRun then revalidates the
same owners atomically and publishes the child's complete supplied intent and target in revision
zero. It never substitutes predecessor intent or target data. Plain/cloned eligibility or candidate
objects cannot reach publication.

- [ ] **Step 1: Write failing provenance/replay tests**

Use actual receipt/ledger temporary stores and producer APIs rather than caller-shaped mocks. Cover:

- valid receipt/auto-event at commit and read; wrong app/capture rejects before revision publication;
- an auto_judged row with no receipt field binds the exact separately validated receipt capability;
  a raw, cloned, wrong-receipt, or already-budget-exhausted capability cannot authorize the row;
- absent validator, missing/tampered receipt/capture/APK, changed/retracted/broken auto event;
- exact event digest over the approved authoritative subset and no later row retroactively upgrading an older revision;
- an injected validator's caller-shaped/cloned event is not effective evidence; a cloned/cast
  ValidatedRunChainV1 or RunProjectionV1 cannot replay or validate an evidence-bearing base;
- a cloned/caller-shaped occupied-projection-required classification cannot mint target-base eligibility;
- broken older evidence strips affected history while a newer independent conclusion remains;
- Door auto-judged-needs-look becomes built-needs-look with valid receipt and no old notes;
- visual-dependent accepted loop becomes provenance-broken; nonvisual accepted keeps accepted through authority-stripped structural projection;
- duplicate visual criteria bind one exact same-iteration event and fail together;
- top-level broken projections expose no historical accepted/verdict/receipt/capture/autoJudgedRecorded:true fields; historicalResult retains the strict old value;
- stripped iteration rows omit visual rows and machine verdict/check/recorded-evidence fields while reporting omitted count;
- 64/+1 receipts/events, per-ledger byte/event/value limits, aggregate work budgets, issue ordering/count/truncation;
- terminal replay does zero planner/Fleet/project/mutable external-input calls and never writes another revision.
- an intact evidence-bearing terminal and a receipt/auto-provenance-only broken terminal may each serve once as an evidence-empty target base when every independent core/lineage/owner/generation condition from Task 5 passes; core-corrupt, unobservable-generation, unattributed-write, or consumed variants reject without a child;
- cloned/forged or twice-consumed projected eligibility makes no candidate and publishes no child;

- [ ] **Step 2: Run RED**

Run:

~~~sh
npm run build && node --test test/runrevision-projection.mjs
~~~

Expected: FAIL because runprojection and exact auto-event resolver exports are absent.

- [ ] **Step 3: Implement producer-valid authority joins**

validateNativeReceiptRef must consume the shared budget before the historical receipt read and mint
a locally branded capability only when app, receipt ID, and capture digest match. The ledger resolver
accepts that exact capability, not a raw receipt ref, and returns a locally branded event only for an
unretracted auto_judged row with intact ledger capture, visual_judge producer provenance, exact
app/sequence/event digest, and the capability's independently validated receipt/capture. The row may
omit a receipt field: receiptId comes only from the exact validated receipt capability bound by the
immutable AutoJudgeEventRefV1. Plain receipt/event objects and public Fleet booleans never authorize it.
Implement validateNativeReceiptRef and resolveAutoJudgeEvent together in ledger.ts so their private
receipt/event capability identity registries and origin assertion are shared; runprojection.ts
calls them through the exact
HistoricalReceiptValidatorV1 and options-bound AutoJudgeValidatorV1. That wrapper forwards the same
mutable ProjectionBudgetsV1 object rather than allocating or resetting one.

Read every core revision/snapshot first. Revalidate only the selected run's required unique receipt/event refs under aggregate budgets. Keep claimed refs/history immutable; compute effective refs/ceiling/lifecycle separately. Build one strict replay arm and always return unchanged/none transport dispositions.

Extend Task 5 target-base consumption only through validateProjectedTargetBase followed by
prepareProjectedChildAdmission with its local brand and Task 5's admitNewRun. Permit intact or provenance-only broken
evidence-bearing terminals after complete projection, but copy no receipt/auto-event/result/
compiler/attempt/evidence state into the child. Any non-projection core or generation failure
remains target-conflict/invalid-store and cannot be softened by this function.

- [ ] **Step 4: Run GREEN and ledger/receipt regressions**

Run:

~~~sh
npm run build
node --test test/runrevision-projection.mjs
npm run test:ledger
npm run test:runreceipt
git diff --check
~~~

Expected: all projection, ledger, and receipt tests pass without evidence promotion.

- [ ] **Step 5: Extend test:runrevision and commit**

Commit:

~~~text
feat(run): revalidate replay provenance

RED: npm run build && node --test test/runrevision-projection.mjs (missing projection/event authority).
GREEN: npm run build; npm run test:runrevision; npm run test:ledger; npm run test:runreceipt; git diff --check.
Only structural/producer auto-judged fixture authority was exercised; no rendered LOOK, hardware, Swan, or Windows claim.
~~~

---

### Task 10: Door 1 revisioned orchestration and two-step compatibility

**Files:**
- Create: src/buildapprun.ts
- Modify: src/doors.ts
- Modify: test/doors.mjs
- Create: test/buildapprun.mjs
- Modify: package.json

**Interfaces:**
- Produces executeBuildAppInvocation(invocation: BuildAppInvocationV1, deps: BuildAppRunDependenciesV1): Promise<BuildAppRunResponseV1>
- Produces parseBuildAppInvocation(publicArgs: unknown): BuildInvocationParseV1
- Consumes Task 5's non-injectable assertCompleteRunStoreScanOrigin before classification/admission.
- Move briefIdOf to buildapprun.ts and re-export it from doors.ts so current imports remain compatible.
- doors.ts retains MCP schema/description/text JSON registration and delegates to the new state machine.
- Defines the orchestration handoff exactly:

~~~ts
export type RunWorkflowResponseCoordinatesV1 = Readonly<{
  runId: LowercaseUuidV4;
  revision: number;
  revisionId: Sha256;
  runStateByThisCall: "unchanged" | "durably-advanced";
  externalSideEffectsByThisCall: "none" | "possible" | "confirmed";
}>;
export type BuildAppPreRunFailureV1 = Readonly<{
  status: "plan-failed";
  detail: JsonValue;
  fix: string;
}>;
export type PicoLoopPreRunFailureV1 =
  | Readonly<{ status: "plan-failed"; iterations: 0;
      detail: JsonValue; fix: string }>
  | Readonly<{ status: "invalid-acceptance"; iterations: 0; fix: string }>;
export type BuildAppRunResponseV1 =
  | BuildAppPreRunFailureV1
  | RunControlResultV1
  | ReplayResultV1
  | (BuildAppPublicResultV1 & RunWorkflowResponseCoordinatesV1);
export type PicoLoopRunResponseV1 =
  | PicoLoopPreRunFailureV1
  | RunControlResultV1
  | ReplayResultV1
  | (PicoLoopPublicResultV1 & RunWorkflowResponseCoordinatesV1);
export type BuildAppRunDependenciesV1 = Readonly<{
  store: RunRevisionStoreV1;
  storeOptions: RunStoreOptionsV1;
  coreValidators: RunCoreValidatorsV1;
  targetValidators: RunTargetValidatorsV1;
  scan: typeof scanRunStore;
  classifyTarget: typeof classifyTarget;
  prepareNewAdmission: typeof prepareNewTargetAdmission;
  prepareReceiptFreeAdmission: typeof prepareReceiptFreeChildAdmission;
  prepareProjectedAdmission: typeof prepareProjectedChildAdmission;
  admitNewRun: typeof admitNewRun;
  projectRun: typeof projectRun;
  validateProjectedBase: typeof validateProjectedTargetBase;
  acquireOwners: typeof acquireRunOwners;
  releaseOwners: typeof releaseDefiniteOwners;
  observeGeneration: typeof observeTargetGeneration;
  collectInputs: typeof collectExternalInputManifest;
  sealInputs: typeof materializeSealedInputView;
  createCapability: typeof createFleetExecutionInputsCapability;
  plan(input: { brief: string; draftSpec: AppSpec | null }):
    Promise<ExternalPhaseCallResultV1<JsonValue>>;
  executeFleet: typeof executeFleetBuild;
  receiptValidator: HistoricalReceiptValidatorV1 | null;
  autoJudgeValidator: AutoJudgeValidatorV1 | null;
  createProjectionBudgets(): ProjectionBudgetsV1;
  monotonicMs(): number;
  nowUtc(): CanonicalUtcTimestamp;
  uuid(): LowercaseUuidV4;
}>;
~~~

There is no plain Fleet envelope dependency. The plan result is parsed through the existing
planner/lint and appSpecSchema contracts before it can populate a revision.

- [ ] **Step 1: Write failing Door 1 lifecycle tests**

Use real run store/locks with injected planner/Fleet. Cover:

- initial brief-only, direct valid draft, initial targetBase child, explicit resume, preferred author, ordinary retry, and permitted replacementSpec amendment;
- invalid invocation mixtures, run ID grammar, stale revision precedence, intent assertion conflict, draft/replacement exclusivity, lifecycle/spec gates;
- every stored normal result has exact runId/revision/revisionId plus transport dispositions, while
  initial invalid AppSpec remains the exact coordinate-free BuildAppPreRunFailureV1;
- revision zero durable before planner; planner scaffold/valid direct draft snapshots; plan-completed before build;
- brief-only returns current needs-authoring fields plus coordinates; exact coordinate-free replay produces no revision/planner call;
- literal {brief} then {brief,draftSpec} selects only one raw-byte-identical awaiting-authoring leaf; concurrent authors produce one winner;
- authored spec commits spec-authored before planner/lint; invalid authored draft leaves awaiting-authoring at unchanged coordinate;
- that invalid authored draft is the one coordinate-bearing plan-failed response outside persisted
  results: unchanged/none, no replayed key, no new revision, and the corrected draft may reuse the
  same expectedRevision;
- paused amendment retains old spec history, sets explicit-amendment/amendsRevision, clears attempt inputs, and equal digest is an ordinary retry;
- capacity/generation/locator/manifest/view/capability validation before attempt-started; no external call before its durable HEAD;
- invalid-store/limit-exceeded RunStoreScanResultV1 arms return the matching control result before
  classification/admission/planning and cannot be softened into coordinate-free legacy handling;
- definite failure statuses preserve current fields; in-doubt commits/retains owners and returns interrupted-in-doubt; terminal exact replay makes zero external calls;
- every accepted invocation calls createProjectionBudgets exactly once after parsing; two
  invocations receive distinct objects, while every projectRun, receipt validation, and auto-judge
  validation within one invocation observes the identical object and its monotonically depleted
  counters; invalid invocations call the factory zero times and no nested helper may replace/reset it;
- a definite external result followed by outcome-revision link failure, alias-retained corruption, linked-head-pending failure, HEAD-authoritative response failure, or unknown publication observation returns only state-write-failed with exact runRevisionCommitted/runRevisionPublication/runStateByThisCall/externalSideEffectsByThisCall fields, retains owners unless durable matching outcome authority permits token-checked release, and never returns a success-shaped status;
- runStateByThisCall/externalSideEffectsByThisCall exact values for planning, replay, no-write failure, definite mutation, stale observer, and initiator ambiguity;
- V1 does not call writeUserBrief or adopt the compatibility leaf.

- [ ] **Step 2: Run RED**

Run:

~~~sh
npm run build && node --test test/buildapprun.mjs test/doors.mjs
~~~

Expected: FAIL because buildapprun delegation/resume fields do not exist.

- [ ] **Step 3: Implement the revisioned Door state machine**

Parse public structural presence first, then the exact invocation union. After any accepted parse,
call createProjectionBudgets exactly once and thread that fresh identity through every projection and
nested authority validator for the whole invocation; never cache it in dependencies or allocate a
replacement below projectRun. For initial valid intent, acquire coordination owners, classify/admit,
branch on the exact scan result, and only then classify/admit from a registered complete scan;
failure arms return their matching control result. The complete arm is opened only through Task 5's
direct WeakSet-backed origin assertion, never a dependency-supplied substitute. Publish revision zero, release after durable HEAD,
plan, and publish plan-completed. For attempt work,
acquire fresh execution owners, re-read expected HEAD, validate generation/capacity, seal
inputs/create capability, publish attempt-started, invoke executeFleetBuild, consume only its live
ValidatedFleetExecutionV1, attribute generation/receipt/compiler, publish exactly one
definite/in-doubt outcome, then release or retain.

Preserve current status payloads by snapshotting the exact strict public result without coordinates. Add runId/revision/revisionId and transport dispositions only after publication. Replay uses projectRun/replayProjectedResult. No Door path reconstructs state from target.briefPath.

- [ ] **Step 4: Run GREEN and Door/receipt regressions**

Run:

~~~sh
npm run build
node --test test/buildapprun.mjs test/doors.mjs
npm run test:runrevision
npm run test:runreceipt
git diff --check
~~~

Expected: all Door 1/run/receipt tests pass and Doors registration still reports 18 tools.

- [ ] **Step 5: Commit measured claims**

Commit:

~~~text
feat(run): make Door 1 revision-resumable

RED: npm run build && node --test test/buildapprun.mjs test/doors.mjs (missing revisioned Door API).
GREEN: npm run build; npm run test:runrevision; npm run test:doors; npm run test:runreceipt; git diff --check.
Hermetic orchestration only; no live app, emulator restoration, Windows, Swan, hardware, or rendered LOOK claim.
~~~

---

### Task 11: pico_loop durable iteration checkpoints and resume

**Files:**
- Create: src/picoloop.ts
- Modify: src/doors.ts
- Create: test/picoloop-run.mjs
- Modify: test/doors.mjs
- Modify: package.json

**Interfaces:**
- Produces executePicoLoopInvocation(invocation: PicoLoopInvocationV1, deps: PicoLoopDependenciesV1): Promise<PicoLoopRunResponseV1>
- Produces parsePicoLoopInvocation(publicArgs: unknown): LoopInvocationParseV1 | PicoLoopPreRunFailureV1
- Move loop helper implementations to picoloop.ts and re-export current public helpers from doors.ts.
- Defines the loop-only dependency extension exactly:

~~~ts
export type PicoLoopDependenciesV1 = Readonly<
  Omit<BuildAppRunDependenciesV1, "plan"> & {
    plan(input: { goal: string; draftSpec: AppSpec | null }):
      Promise<ExternalPhaseCallResultV1<JsonValue>>;
    resetLogcat(app: string):
      Promise<ExternalPhaseCallResultV1<null>>;
    evaluateCriterion(input: {
      criterion: StrictAcceptanceCriterionV1;
      iteration: number;
      fleet: ValidatedFleetExecutionV1;
    }): Promise<ExternalPhaseCallResultV1<CriterionOutcomeV1>>;
    recordStructuralLedger(input: {
      app: string;
      claim: string;
      receipt: NativeReceiptRefV1 | null;
    }): Promise<ExternalPhaseCallResultV1<StructuralLedgerResultV1>>;
    replan(input: {
      goal: string;
      currentSpec: AppSpec;
      failures: readonly CriterionOutcomeV1[];
    }): Promise<ExternalPhaseCallResultV1<{
      spec: AppSpec;
      mutation: "patched" | "unchanged";
    }>>;
  }
>;
~~~

Fleet returns only ValidatedFleetExecutionV1. Each phase result supplies the exact
definite/in-doubt and external-mutation disposition consumed by the attempt accumulator.

- [ ] **Step 1: Write failing loop checkpoint/resume tests**

Cover:

- initial goal/acceptance/draft/budget/onFail/targetBase and resume/amend unions with assertion-only repeated fields;
- every durable normal loop result has the exact coordinate/transport intersection, while invalid
  initial draft/acceptance remains the coordinate-free PicoLoopPreRunFailureV1;
- a missing or empty logcat pattern returns coordinate-free invalid-acceptance with iterations:0 and no run directory, revision, owner, planner, manifest, or Fleet call;
- ready-to-plan, ready-to-build, ordinary pause, and HEAD-durable iteration-completed resume after a fresh process;
- exact normalized acceptance identities, logcat-first stable evaluation, duplicate criteria, and deterministic iterationsLog/perf trail;
- total completed-count and next index survive restart; one fresh external manifest/capability per attempt;
- attempt-started before logcat reset/Fleet/acceptance/ledger/replan and no hidden mid-iteration checkpoint;
- crashes/ambiguity after logcat, Fleet, receipt, criteria, structural ledger, or replan retain owners, never reuse partial outcomes/replanned object/PID/capture, and never retry same run;
- compiler/receipt/auto-event/structural-ledger mappings and external mutation accumulator;
- timeMin negative/zero/fractional/1440/+epsilon, monotonic forward/backward wall-clock discontinuity, zero pre-attempt policy terminal, and per-active-invocation semantics;
- final paused iteration resume produces policy-terminal without Fleet when total iteration budget is consumed;
- replan result persists retained-lesson-repair only on definite safe mutation; no-progress/manual-repair/onFail stop status compatibility;
- exact replay and provenance projection behavior from Task 9.
- the inherited projection-budget factory has the same once-per-accepted-invocation/fresh-identity
  contract as Door 1, and the exact object reaches all loop projection receipt/event joins;
- a definite loop result followed by each outcome-revision/HEAD/response publication failure uses the same exact state-write-failed transport fields as Door 1, retains owners until durable definite authority permits release, and never exposes accepted, built-needs-look, or another success-shaped result;

- [ ] **Step 2: Run RED**

Run:

~~~sh
npm run build && node --test test/picoloop-run.mjs test/doors.mjs
~~~

Expected: FAIL because durable loop APIs/checkpoints are absent.

- [ ] **Step 3: Implement loop state transitions**

After parsing, apply Task 10's single fresh projection-budget identity for the entire accepted loop
invocation. Persist valid intent/revision zero before planning. Publish plan-completed with the parsed
working spec. Before each iteration, enforce policy/capacity under ordered owners, publish a fresh
attempt input ref and durable attempt-started, then run the existing
logcat/Fleet/evaluation/ledger/replan behavior through injected disposition-reporting boundaries.

Publish one iteration-completed, attempt-paused, attempt-conflicted, run-terminal, policy-terminal, or attempt-in-doubt revision. Consume only the live origin-bound ValidatedFleetExecutionV1. Reconstruct public logs only from immutable outcome revisions and their acceptance identities. A later attempt consumes only its new current spec/payload/manifest; no previous runtime or visual proof is reused.

- [ ] **Step 4: Run GREEN and all Door tests**

Run:

~~~sh
npm run build
node --test test/picoloop-run.mjs test/buildapprun.mjs test/doors.mjs
npm run test:runrevision
npm run test:ledger
git diff --check
~~~

Expected: all loop/Door/store/ledger tests pass and no background fixture process remains.

- [ ] **Step 5: Commit measured claims**

Commit:

~~~text
feat(run): persist pico_loop checkpoints

RED: npm run build && node --test test/picoloop-run.mjs test/doors.mjs (missing durable loop API).
GREEN: npm run build; npm run test:runrevision; npm run test:doors; npm run test:ledger; git diff --check.
Injected iterations and evidence fixtures only; no live capture LOOK, hardware, Swan, or Windows claim.
~~~

---

### Task 12: Run-aware pico_next routing and immutable actions

**Files:**
- Create: src/runnext.ts
- Modify: src/doors.ts
- Create: test/piconext-runstore.mjs
- Modify: test/doors.mjs
- Modify: package.json

**Interfaces:**
- Produces selectNextRun(scanResult: RunStoreScanResultV1, validators: RunProjectionValidatorsV1, budgets: ProjectionBudgetsV1): PicoNextRunStoreStateV1
- Produces buildNextAction(selection: PicoNextRunStoreStateV1, chain: ValidatedRunChainV1 | null): { situation: string; nextAction: PicoNextActionV1; alternatives: PicoNextActionV1[] }
- Consumes Task 5's non-injectable assertCompleteRunStoreScanOrigin before selection or legacy fallback.
- Existing pico_next retains exactly situation, nextAction, alternatives, and state; state gains runStore while state.briefs remains the legacy scan.
- RunProjectionValidatorsV1 is exactly { receipt: HistoricalReceiptValidatorV1 | null; autoJudge: AutoJudgeValidatorV1 | null }.

- [ ] **Step 1: Write failing complete-scan/routing tests**

Cover:

- reserved-only root enables legacy fallback; any canonical UUID file/symlink, malformed/unknown/staging/corrupt run suppresses it;
- complete scan before selection and limit-exceeded rather than first-4,096 partial choice;
- shallow/deep cloned or caller-shaped complete scan result cannot authorize a selected run or the
  reserved-only legacy fallback;
- eligible class before hard blocker before terminal, with routing timestamp descending then lowercase runId ascending within a class;
- live owner, recovery-required tail, interrupted-in-doubt, external conflict, invalid store, and provenance-broken routing;
- validate external receipt/auto authority only for the selected candidate and enforce aggregate authority budgets before a partial result;
- each pico_next call creates one fresh initial ProjectionBudgetsV1, passes that exact identity to
  selection and every nested receipt/event join, and never caches or resets it across candidates or
  invocations;
- exact runStore key presence/nullability, issue order/count/truncation, degraded flag, expectedRevision equals authoritative/recoverable-tail revision;
- open/paused actions carry exact runId/expectedRevision; awaiting-authoring includes immutable scaffold; terminal action replays;
- provenance-broken action creates an evidence-empty child with exact immutable initial inputs/current spec/policy and targetBase;
- irreconcilable in-doubt/conflict/invalid/limit branches route to pico_fix without false recovery promises;
- pico_next and terminal replay make zero mutable source/external-input calls and never reference ~/.pico-mcp/briefs for a V1 action;
- legacy actions and at-most-three alternatives retain current behavior only under clean no-V1 presence.

- [ ] **Step 2: Run RED**

Run:

~~~sh
npm run build && node --test test/piconext-runstore.mjs test/doors.mjs
~~~

Expected: FAIL because runnext and state.runStore routing are absent.

- [ ] **Step 3: Implement authoritative routing**

Branch on scanRunStore's exact result. A failure arm routes directly to its matching pico_fix state
with no selection or legacy scan; only a registered complete scan enters core classification. Select
only after Task 5's exported WeakSet-backed assertion directly returns that scan (the assertion is
not injectable); then call projectRun for the selected run under receipt/ledger
budgets. Build actions exclusively from validated immutable goal/acceptance/policy/spec/target
snapshots. Keep environment/camera actions as alternatives only when they do not contradict the
selected run branch.

The Door registration creates exactly one fresh initial ProjectionBudgetsV1 for each pico_next call
and threads that identity through selection; nested projection cannot replace or reset it.

For clean reserved-only roots, invoke the unchanged legacy brief/receipt/ledger algorithm. Do not synthesize a V1 user brief or hash current external assets during discovery.

- [ ] **Step 4: Run GREEN**

Run:

~~~sh
npm run build
node --test test/piconext-runstore.mjs test/doors.mjs
npm run test:runrevision
npm run test:runreceipt
git diff --check
~~~

Expected: every routing class and legacy fallback passes with 18 Doors.

- [ ] **Step 5: Commit measured claims**

Commit:

~~~text
feat(run): route pico_next through run heads

RED: npm run build && node --test test/piconext-runstore.mjs test/doors.mjs (missing run-store routing).
GREEN: npm run build; npm run test:runrevision; npm run test:doors; npm run test:runreceipt; git diff --check.
Routing/provenance fixtures only; no live emulator, visual, Swan, hardware, or Windows conclusion.
~~~

---

### Task 13: Focused gate, CI/docs integration, independent review, and measured acceptance

**Files:**
- Modify: package.json
- Modify: .github/workflows/gates.yml
- Modify: README.md
- Modify: QUICKSTART.md
- Modify: SKILLS.md
- Modify: CAPABILITIES.md
- Modify: test/docsmeta.mjs
- Modify: TESTERS.md
- Modify: docs/COLLABORATORS.md

**Interfaces:**
- test:runrevision runs every Task 1–12 focused file in deterministic order.
- Linux CI runs the hermetic focused gate; POSIX child-process durability cases run only where their prerequisites exist and report their exact lane.
- Documentation keeps the two-step initial Door flow and adds preferred coordinate resume/amend examples.

- [ ] **Step 1: Write failing documentation/metadata and package-gate expectations**

Extend executable docs metadata fixtures to require:

- runId/expectedRevision examples for Door 1 and pico_loop;
- targetBase only for a new child of an eligible terminal generation;
- explicit statements that workflow resume is not emulator snapshot/source/install rollback;
- per-invocation timeMin, finite no-GC store lifetime, POSIX-only durability, non-resumable in-doubt, and public Fleet coordination boundary;
- structural/auto_judged ceiling and exact receipt-bound LOOK obligation;
- unchanged 18-tool Doors count and no managed-latest/Windows claim drift.

Run the existing metadata test once and record the expected mismatch before changing docs.

- [ ] **Step 2: Integrate the complete focused command and CI lane**

Set test:runrevision to:

~~~json
"test:runrevision": "node --test test/runrevision-contracts.mjs test/runrevision-store.mjs test/runrevision-locator.mjs test/runrevision-locks.mjs test/runrevision-lineage.mjs test/runrevision-inputs.mjs test/fleetexecution.mjs test/fleetcoordination.mjs test/runrevision-projection.mjs test/buildapprun.mjs test/picoloop-run.mjs test/piconext-runstore.mjs"
~~~

Add the same gate to .github/workflows/gates.yml without changing or absorbing the separate Windows probe workflow. scripts/run-battery.mjs already discovers every test:* script; do not edit it. Update executable battery-count expectations and documented counts so automatic discovery includes test:runrevision exactly once.

- [ ] **Step 3: Update public docs with exact boundaries**

Document initial, author, resume, retry, amendment, terminal replay, and provenance-broken child examples. State that occupied pre-V1/changed targets now fail closed; public Fleet coordinates V1-owned apps/projects but direct low-level tools remain outside V1. Do not advise manual deletion of runs/locks/lineage to evade bounds.

- [ ] **Step 4: Run focused and regression gates before review**

Run:

~~~sh
npm run build
npm run test:runrevision
npm run test:runreceipt
npm run test:ledger
npm run test:doors
npm run test:semantic
npm run test:distribution-adoption
npm run test:docsmeta
git diff --check
SMOKE_SDK_OPTIONAL=1 node scripts/run-battery.mjs
~~~

Expected: every focused/named regression gate exits zero. Report the broad battery's exact pass/fail count; the known local scene_schemas absence remains a disclosed smoke failure unless the local SDK evidence changes.

- [ ] **Step 5: Commit the integration with only measured claims**

Commit:

~~~text
docs(run): publish revisioned resume v1

Tests: replace this line with each command's observed exit status and exact pass/fail/skip count, including the broad battery summary and its named smoke failure if still present.
Structural hermetic/POSIX evidence only; no native Windows, live Swan/hardware, emulator restoration, or rendered LOOK claim.
~~~

- [ ] **Step 6: Run independent whole-subproject review and one bounded fix wave**

Generate a review package from acdbebb6db2aabd72b2f3320b8dced7fa9b1864c to the final implementation HEAD. The independent reviewer must check the complete approved design, plan ledger, every deferred minor, strict store/lock/capability/orchestration/evidence boundaries, and both specification compliance and code quality.

If Critical or Important findings exist, dispatch one implementer with the complete finding list, require RED/GREEN covering tests and a measured fix commit, then run one scoped independent re-review. If that re-review leaves any Critical or Important finding, mark Subproject 3 incomplete/blocked and report it; do not claim acceptance or begin change-aware iteration. The subproject reaches acceptance only when independent review reports zero unresolved Critical and Important findings.

## Plan Self-Review Record

- **Spec coverage:** Tasks 1–5 cover canonical intent, strict envelopes, CAS/revisions/HEAD, paths, generations, bounds, locking, recovery, lineage, and target bases. Tasks 6–8 cover sealed inputs, Fleet core/native dispositions, public Fleet coordination, and legacy boundaries. Tasks 9–12 cover evidence projection/replay, Door 1, pico_loop, and pico_next. Task 13 covers documentation, CI, measured gates, and independent acceptance.
- **Clarifications frozen:** sidecar/IBL ordering and URI grammar are explicit in Global Constraints and Task 6; configured-root authority is explicit in Global Constraints, Task 5, and documentation requirements.
- **Type consistency:** Build/loop orchestration consumes Task 1 invocation/state unions, Task 2
  store factory/CoreRunChainV1, Task 5's Task-3-validated ValidatedRunChainV1, Task 4 lock-backed
  authority, Task 6 capability, Task 7 ValidatedFleetExecutionV1, and Task 9 RunProjectionV1.
  Public Fleet consumes Tasks 3–8 without run-write authority. pico_next consumes Tasks 2/5/9
  and performs no mutable input collection.
- **Dependency consistency:** Task 2 uses an injected authority verifier and is independently green before Task 4 supplies production owner validation. Task 4 has no capability/Fleet marker dependency. Task 8 owns public markers after Tasks 6/7. Task 5 consumes receipt-free bases; Task 9 adds evidence-bearing projected bases.
- **Placeholder scan:** every task has exact files, exported interfaces, a named failing test command/reason, implementation rules, green/regression commands, and evidence requirements. Task 13 names TESTERS.md, docs/COLLABORATORS.md, and test/docsmeta.mjs explicitly. No deferred implementation marker is part of the plan.
- **Scope boundary:** stable compiler-step reuse, output digest reuse, readiness polling, and phase timing optimization remain Subproject 4 and are not implemented here. This plan always performs a fresh normal attempt after an eligible pause.
