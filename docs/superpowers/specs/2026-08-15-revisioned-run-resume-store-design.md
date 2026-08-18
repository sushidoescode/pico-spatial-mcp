# Revisioned Run and Resume Store v1 Design

**Date:** 2026-08-15
**Programme:** [PICO MCP Evolution Programme](2026-08-14-pico-evolution-programme-design.md)
**Base:** `c9931eb3e683888aca9f21e48013560a41c56ec3` (`pico-evolution-2026-08-14`)
**Status:** Approved by the user on 2026-08-16; implementation planned
**Scope:** Durable POSIX workflow state for Door 1 (`pico_build_app`) and `pico_loop`

## Purpose

Make Door 1 and `pico_loop` resumable from an open, ordinary paused, or definitely completed
checkpoint after an MCP process or client session ends without asking the caller to resend the
complete AppSpec and without treating mutable process memory, user briefs, or a reused Android
project as authoritative workflow state. An execution that may still have live descendants is an
explicit non-resumable in-doubt boundary in V1, not a checkpoint that can safely be replayed.

Every accepted workflow receives a server-generated `runId`. Its state advances through immutable,
content-identified revisions. A resume call supplies `{runId, expectedRevision}` and may execute only
when that expectation still names the committed head and the current project generation agrees with
the stored boundary. Competing revisioned workflows and the public `fleet_build` entry point share
application/device and physical-project resource locks; changed intent, corrupt state, and ambiguous interrupted work fail closed
before new project, build, install, launch, or capture side effects.

This store records workflow history. It does not turn a build, receipt, automated-eye result, or
resume event into visual proof. The governing LOOK rule remains unchanged: a visual claim requires a
human or vision-capable agent to open and judge the exact receipt-bound capture.

## Non-goals

V1 does not:

- restore an emulator snapshot, adb session, PID, foreground state, or installed application;
- undo or merge user edits in a generated Android project or mutable user brief;
- resume inside an individual generator or Gradle process after that process has ended;
- provide stable compiler-step reuse or skip unchanged build/install phases; that is Subproject 4;
- change the digest-bound native run receipt v1 schema or mint a receipt retrospectively;
- promise bit-for-bit replay across MCP, SDK, Gradle, adb, or packaged-template version changes;
  each new attempt uses the currently installed implementation and records its resulting ledger,
  writes, and receipt, while the exact AppSpec-selected external inputs below are separately bound;
- persist or infer `vision_verified` or `device_verified` evidence;
- provide distributed coordination across hosts or network filesystems;
- garbage-collect, compact, delete, or rewrite completed runs or shared snapshot objects;
- abandon, fork, or rebase an open/paused run onto changed acceptance or policy at the same target;
- protect against a privileged local actor that can replace the complete store and its anchor
  consistently;
- coordinate direct low-level full-surface scaffold/generator/adb tools invoked outside Door 1,
  `pico_loop`, or public `fleet_build`; those are non-cooperating external writers, and V1 detects
  surviving selected-input changes but cannot serialize their transient device side effects;
- make a native-Windows durability or operational claim; or
- change the managed-latest CLI track, repository visibility, permissions, remotes, or release state.

Cross-platform unit contracts may remain green, but POSIX is the only durability and concurrency
lane in scope. Windows operational behavior remains separately owned.

## Chosen approach

V1 uses an immutable, hash-linked revision chain plus a small atomically replaced `HEAD.json` anchor
and owner-token execution locks.

Each revision is published create-only. It contains a complete bounded workflow-state snapshot,
the identity of its exact parent, and the transition that produced it. `HEAD.json` names the last
committed revision and detects a missing or corrupt tail relative to that anchor. Revision
publication precedes head publication, so an interrupted write can leave only a recognizable
uncommitted tail; recovery never invents an outcome or moves the head backward.

Two alternatives were rejected:

1. **Scanning revisions without a head** is simpler, but deletion of the newest revision silently
   makes an older revision look current.
2. **SQLite/WAL** gives strong transactions but adds a native/database dependency, migration and
   repair surface, and a second authority that conflicts with the programme's revision-file
   contract.

`HEAD.json` is a local crash/corruption anchor, not an external transparency log. A privileged actor
that consistently replaces the head and every affected revision remains outside the V1 threat
model, matching the receipt store's local-attacker boundary.

## Architecture

Six focused units own distinct responsibilities:

1. **Run revision store** validates canonical intent, publishes immutable snapshots and revisions,
   reads the complete chain, maintains `HEAD.json`, and returns strict fail-closed results.
2. **Fleet input identity** resolves physical project locators and bounded external host inputs,
   publishes per-attempt manifests, and issues only locally branded core capabilities.
3. **Run execution locks** serialize one run, one mutable installed-application resource, and one
   physical project resource using nonempty owner-token directories, PID plus process-start identity,
   and token-checked release.
4. **Door 1 orchestration** owns the scaffold/author/build state machine and preserves every current
   public result field while adding run coordinates.
5. **Loop orchestration** persists the current AppSpec, budget position, iteration results,
   compiler outcome, receipt references, and next transition instead of retaining them only in a
   handler closure.
6. **Run projection** joins immutable workflow history with freshly revalidated receipt provenance
   and supplies authoritative continuation coordinates to `pico_next`.

The run layer owns revision publication. The shared Fleet execution core, compiler, receipt
producer, ledger, and visual judge remain unaware of `runId` and `expectedRevision`. Fleet returns
the exact bounded execution/compiler/write-set union defined below, but it does not become a
run-store writer.

The implementation places the store in a focused `src/runrevisionstore.ts` module, the locator and
external-input collector/capability factory in `src/fleetinputidentity.ts`, and moves the two large
orchestration bodies out of `doors.ts` to `src/buildapprun.ts` and `src/picoloop.ts`. MCP
registration, descriptions, and the 18-tool Doors surface remain in
`doors.ts`. This is targeted separation for the new state boundary, not a general refactor.

## Storage layout

The default root is `~/.pico-mcp/runs`. Hermetic tests may override it with
`PICO_MCP_RUN_DIR`. The layout is:

```text
<root>/
  objects/
    goal/<sha256>.json
    acceptance/<sha256>.json
    spec/<sha256>.json
    brief/<sha256>.json
    external/<sha256>.json
    compiler/<sha256>.json
    result/<sha256>.json
  locks/
    run/<runId>.lock/
    run/<runId>.lock.released.<owner-token-sha256>.<cleanup-token>/
    application/<application-resource-key-sha256>.lock/
    application/<application-resource-key-sha256>.lock.released.<owner-token-sha256>.<cleanup-token>/
    project/<physical-project-resource-key-sha256>.lock/
    project/<physical-project-resource-key-sha256>.lock.released.<owner-token-sha256>.<cleanup-token>/
  staging/
    fleet-inputs/<owner-token>-<attemptId>/
  <runId>/
    HEAD.json
    revisions/
      0.json
      1.json
      ...
```

`runId` is a server-generated canonical lowercase UUIDv4. A caller cannot choose it, and it is
never derived from `briefId`, package name, goal text, receipt ID, PID, or a timestamp. The existing
`briefId`, `com.fleet.<briefId>`, user-brief path, and `fleet-<briefId>-native` project mapping remain
the mutable application identity used by the current pipeline.

Because `briefIdOf` has a finite hash space, a new run does not treat matching target paths as proof
that two goals are the same. Before publishing revision zero, it resolves the physical project
locator, generates the run ID, acquires that run's coordination lock, the application-resource lock,
and the physical-project lock in that order, revalidates the locator, and classifies the target:

- a target with no prior V1 run and both the canonical user-brief leaf and fleet project absent is
  new and may be admitted;
- any target with a prior V1 run or either mutable resource present is occupied and requires the
  initial call's exact `targetBase:{runId,revision,revisionId}` assertion; and
- an occupied target is admitted only when that coordinate is the valid HEAD of a terminal
  V1 run for the same application-resource key, project-resource key/physical directory, and exact
  byte-for-byte `target.briefInput`, its terminal expected
  generation has the closed basis defined below and equals the freshly observed target generation,
  it is the sole unconsumed leaf of that resource key's linear V1 lineage, its effective projection
  has a readable intact core (receipt/auto-judge projection authority may be broken), and no retained
  execution lock exists.

Normalized-equal but byte-different briefs, legacy targets with no V1 authority, a stale or
non-HEAD target base, an in-doubt or externally conflicted predecessor, a generation mismatch, and
multiple fields that map inconsistently all return `target-conflict` without creating a run or
overwriting either resource. `targetBase` is explicit authorization to start a new workflow over
one exact prior generation and is consumed by at most one child run; it is not permission to
restore that generation. Under the application and physical-project resource locks, admission scans the bounded
application-resource lineage,
requires every base edge to form one acyclic chain, requires the named predecessor to have no child,
and publishes the new root as that unique child. A duplicate initial request therefore returns
`target-conflict` and discovers/resumes the already-created leaf rather than branching the lineage.
A terminal run may still be replayed by its own coordinates, while a genuinely different acceptance
or execution policy may use a new run plus that terminal leaf as its explicit target base. A
nonterminal leaf reserves its target: V1 has no implicit abandon/fork transition, so changing
acceptance or policy then requires either continuing the run to a terminal state or choosing a
different brief/goal target. This closes
target-hash collisions, replayed-base branching, and silent same-goal adoption without changing the
established brief/package/project naming contract.

A terminal expected generation has a closed base in exactly one of two ways: its
`projectGeneration.lastAttempt` carries a non-null definitely completed attribution whose `after`
equals `expected`; or the complete chain contains no `attempt-started` transition and every revision
retains revision zero's freshly observed brief/project generation unchanged. The second case
permits a zero-time-budget policy terminal to become the next lineage base without pretending that
an attempt ran. Attempt-input manifests are attempt history, not target-base generation: a child
does not inherit them. A null/ambiguous attribution after any started attempt, or any unexplained
expected-generation change, is ineligible.

A provenance-broken terminal may therefore be an explicit `targetBase` only when the broken state
is confined to revalidated receipt/auto-judge projection authority and every independent core,
lineage, lock, and generation condition above still passes. The child inherits no receipt ref,
auto-judge ref, evidence ceiling, public conclusion, or reusable runtime state from that base; it
starts a fresh workflow and must execute to obtain new authority. Core corruption, an unobservable
generation, or a broken write attribution is never softened into this rebuild path.

Run IDs and revision filenames are validated before path construction. Revision numbers begin at
zero, are contiguous unsigned decimal integers, and have no sign or leading zero. Reserved root
directories cannot parse as run IDs.

Initial allocation makes at most four UUID attempts. An existing run directory, run lock, or unsafe
path reserves that ID and is never opened as a new run. Exhaustion returns `state-write-failed`
without touching an existing run.

Snapshot paths are derived from their type and digest; no path read from JSON is trusted. Each
snapshot is a strict, versioned canonical JSON envelope followed by one newline. The digest and
`bytes` field cover the canonical envelope without that trailing newline.

## Canonical intent and snapshots

### Goal

For Door 1 the goal is its `brief`; for `pico_loop` it is `goal`. Goal normalization:

1. bounds the original caller string to 256 KiB of UTF-8 before `briefIdOf` or normalization;
2. converts CRLF and bare CR to LF;
3. applies Unicode NFC;
4. trims only outer Unicode whitespace;
5. preserves internal whitespace, tabs, line breaks, punctuation, and case; and
6. rejects an empty result, NUL, other C0 controls except tab/newline, or more than 64 KiB of UTF-8.

Compatibility target identity is deliberately separate from normalized intent identity.
`briefIdOf` receives the original caller string exactly as it does today; normalization never
changes the established `briefId`, package, user-brief path, or project directory. The normalized
value is used only for run intent, snapshot identity, and redundant resume assertions. The bounded
original string is retained as immutable `target.briefInput` so readers can recompute the legacy
mapping and require exact target-base equality; it is not a second mutable goal. A resumed call
never recomputes its target from optional assertion text.

A repeated goal on resume is an optional assertion, not replacement input. Its normalized digest
must equal the run's root goal digest or the call returns `intent-conflict` before any new revision
or external call.

### AppSpec

Every stored AppSpec is parsed through `appSpecSchema`, including all schema defaults, and then
canonicalized with the existing run-receipt canonical JSON rules. The run preserves separate refs
for the initial scaffold/authored spec and the current working spec. A current-spec ref also records
one origin:

- `planner-scaffold`;
- `caller-authored`;
- `retained-lesson-repair`; or
- `explicit-amendment`.

`initialSpec` is null only until the first schema-valid planner or caller spec is committed; it then
never changes. `currentSpec` follows the working spec. Its `amendsRevision` is non-null only for
`explicit-amendment` and names the exact prior HEAD the caller amended; every other origin uses
null. An authored Door 1 continuation retains the planner scaffold as `initialSpec` and changes only
`currentSpec` through `spec-authored`.

Ordinary resume cannot replace the current spec. Door 1 may accept `draftSpec` only while its head
is `awaiting-authoring`. A paused run may accept a separately named `replacementSpec`; it is parsed,
published, and committed as an explicit amendment under the caller's `expectedRevision` before a
new attempt. If its digest equals the current spec, it is treated as an ordinary retry rather than
creating a no-op amendment.

`spec-amended.previousSpec` is null only when a no-draft planning failure left `currentSpec:null`;
that first valid replacement also initializes the previously null `initialSpec`. Otherwise the
field must equal the prior current-spec snapshot digest.

Door 1 permits explicit amendment from `plan-failed`, `failed`, `built-not-installed`, or
`built-no-capture`. The loop permits it from `plan-failed`, `unmeasurable-acceptance`, `no-progress`,
or `manual-repair-required`. A run blocked by `external-state-conflict` does not accept an amendment
as permission to overwrite changed project bytes and cannot serve as `targetBase`; V1 directs the
caller to a different target. A future explicit adoption/reconciliation interface is out of scope.

The old spec object remains reachable from earlier revisions. The run store never rewrites a spec
snapshot or mutates the project to resemble an old spec.

### Acceptance and execution policy

The public MCP schema remains the current compatibility shape: every criterion accepts the current
optional field set, Zod strips unknown keys as it does today, and a logcat criterion with a missing
or empty `pattern` reaches the existing `invalid-acceptance` result instead of becoming an
MCP-schema error. Only after that public parse does the run layer create a strict per-kind internal
value:

- `structural`: `{kind,inputIndex,entitiesPresent,minEntities,componentsPresent}`, with omitted
  arrays expanded to `[]` and omitted `minEntities` represented as null;
- `visual`: `{kind,inputIndex}`; all currently accepted but irrelevant fields are discarded;
- `logcat`: `{kind,inputIndex,pattern,tag,timeoutSec}`, with omitted or empty tag represented as null
  to preserve the current truthy omission, and timeout expanded to 20;
- `perf`: `{kind,inputIndex,minAppFpsP5,durationSec}`, with the current effective defaults 60 and
  15. To preserve today's truthiness behavior, an explicit zero `durationSec` also normalizes to 15;
  other values accepted by the public schema remain stored and retain the current inner-tool
  validation behavior.

Each strict criterion receives `criterionDigest`, the SHA-256 of its canonical value with
`criterionDigest` omitted. `inputIndex` distinguishes duplicate criteria. The acceptance snapshot
preserves caller array order and duplicates; it is never sorted. Evaluation stores outcomes in the
current evidence-safe order—logcat indices first, stable order within both partitions—and every
outcome repeats `{inputIndex,criterionDigest}` so duplicate criteria cannot be associated by value
or position in the reordered array.

The persisted union is therefore:

```typescript
type StrictAcceptanceCriterionV1 =
  | { kind: "structural"; inputIndex: number; criterionDigest: Sha256;
      entitiesPresent: string[]; minEntities: number | null;
      componentsPresent: string[] }
  | { kind: "visual"; inputIndex: number; criterionDigest: Sha256 }
  | { kind: "logcat"; inputIndex: number; criterionDigest: Sha256;
      pattern: string; tag: string | null; timeoutSec: number }
  | { kind: "perf"; inputIndex: number; criterionDigest: Sha256;
      minAppFpsP5: number; durationSec: number };
```

`inputIndex` is the zero-based caller-array index. Array/string/numeric values must still satisfy
the current public Zod parse; the internal layer adds only the global count/byte bounds and the
nonempty logcat-pattern gate. Ignored cross-kind fields never enter the digest.

Acceptance is immutable for one run. Reordered, added, removed, or changed criteria return
`acceptance-conflict` when redundantly supplied on resume. Budget and `onFail` are normalized and
stored with the root intent. A completed or budget-exhausted run is not reopened by silently raising
the budget; a caller starts a new run from an eligible terminal base, or uses a different target,
for a different execution policy.

Policy normalization is exact: omitted `iterations`, `timeMin`, and `onFail` become `3`, `20`, and
`replan`. Accepted `budget.toolCalls` remains intentionally inert and always normalizes to the
literal `"inert"`, so changing that ignored input cannot change run identity or execution.

`budget.iterations` is a total run limit: every definitely finished Fleet attempt that reaches a
normal `IterationStateV1.blocked|completed` outcome increments `completedCount`, which does not reset
on resume. A durable external-state conflict ends the run before an iteration outcome and does not
need a reusable count. An interrupted in-doubt attempt does not consume that count, but it also
cannot be retried in the same run.
`budget.timeMin` retains its current active-invocation meaning and accepts any finite public-schema
number in the inclusive range `0..1440`; fractions are preserved. Negative values return
`invalid-policy`, values above 1440 return `limit-exceeded`, and non-finite values cannot pass the
JSON/Zod boundary. Zero permits intent/planning checkpoints but commits `policy-terminal` before the
first attempt. Each initial or resumed MCP call gets that bounded active window; time while no
handler is running does not consume it. The result and documentation disclose this per-invocation
boundary rather than presenting it as a durable wall-clock deadline.
All elapsed budget decisions use one injected monotonic clock sampled at invocation start and phase
boundaries. Wall time is used only for canonical persisted timestamps and diagnostics; a wall-clock
jump cannot extend or shorten an execution window.

### Snapshot reference

Revisions use this strict reference shape:

```json
{
  "kind": "goal",
  "algorithm": "sha256",
  "sha256": "<64 lowercase hex>",
  "bytes": 1234
}
```

`kind` is exactly one of `goal`, `acceptance`, `app-spec`, `brief-payload`, `external-input`,
`compiler-ledger`, or `public-result`;
the derived CAS directory and strict snapshot envelope must agree with it.

```typescript
type SnapshotRefV1 = {
  kind: "goal" | "acceptance" | "app-spec" | "brief-payload" |
    "external-input" | "compiler-ledger" | "public-result";
  algorithm: "sha256";
  sha256: Sha256;
  bytes: number;
};

type PublicWorkflowStatusV1 =
  | "needs-authoring" | "plan-failed" | "failed" | "built-not-installed"
  | "built-no-capture" | "auto-judged-needs-look" | "built-needs-look"
  | "accepted" | "unmeasurable-acceptance" | "no-progress"
  | "manual-repair-required" | "budget-exhausted";
```

The seven envelope schemas are exact:

```typescript
type GoalSnapshotV1 = {
  kind: "pico.workflow-goal";
  schemaVersion: 1;
  goal: string;
};

type AcceptanceSnapshotV1 = {
  kind: "pico.workflow-acceptance";
  schemaVersion: 1;
  criteria: StrictAcceptanceCriterionV1[];
};

type AppSpecSnapshotV1 = {
  kind: "pico.workflow-app-spec";
  schemaVersion: 1;
  spec: AppSpec;
};

type BriefPayloadSnapshotV1 = {
  kind: "pico.workflow-brief-payload";
  schemaVersion: 1;
  id: string;
  brief: string;
  spec: AppSpec;
};

type ExternalInputSnapshotV1 = {
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

type CompilerStepExecutionV1 = {
  disposition: "scaffolded" | "reused-project" | "executed-success" |
    "native-stage-success" | "executed-failed" | "native-stage-failed" |
    "not-attempted" | "in-doubt";
  outputConfirmation: "confirmed" | "unconfirmed" | "not-applicable";
  detailDigest: Sha256 | null;
};

type ProjectWriteRecordV1 = {
  path: string;
  origin: "scaffold" | "compiler-step" | "asset-delivery" | "fleet-runtime";
  stepOrder: number | null;
  before: null | { bytes: number; sha256: Sha256 };
  after: null | { bytes: number; sha256: Sha256 };
};

type CompilerLedgerSnapshotV1 = {
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

type PublicResultSnapshotV1 = {
  kind: "pico.workflow-public-result";
  schemaVersion: 1;
  workflow: "pico-build-app" | "pico-loop";
  status: PublicWorkflowStatusV1;
  publicResult: BuildAppPublicResultV1 | PicoLoopPublicResultV1;
};
```

`StrictAcceptanceCriterionV1` is the normalized per-kind union defined above, including its
`inputIndex` and `criterionDigest`. `AppSpec` is the exact result of `appSpecSchema.parse`, not the
caller's unparsed object. The brief payload's ID and exact original brief must match the target, and
its schema-parsed spec must equal the current AppSpec snapshot. Compiler step `order` is a
contiguous zero-based integer, `note` expands from omitted to null, and `args` is a canonical JSON
object. The snapshot is Fleet's exact post-package-rewrite `buildLedger` plan, not a second
compilation of the stored pre-rewrite AppSpec. It contains the entire ledger, including scaffold and
`build_and_run`, even though Fleet implements those two stages outside the generator loop. The
compiler envelope is capped at 4,096 steps, 20,000 project-write records, and 8 MiB.

The external-input snapshot is the ordered, deduplicated identity of the closed caller-selected
host-file set Fleet can derive from the current AppSpec: `meta.semanticScenePath`,
`meta.occupancyPath`, `scenes[].environment.asset` for textured-mesh, splat, and pano routes,
`objects[].seatOn.asset`, every safe model sidecar, and each selected IBL source. `data[].asset` is
an APK-relative generated-output path, `baseColorImage` is currently generator text rather than a
host-file read, and network/runtime endpoints are outside this host-file manifest. `uses` preserves
AppSpec order and duplicate references; `files` is sorted by canonical resolved path and hashes each
unique file once. `order` and non-null file indices are contiguous zero-based integers, every index
is in range, and only an unresolved IBL choice may use null. A project-generation IBL choice hashes
the selected project destination too and must equal the same entry in the matching
`attempt-started.generation` Gradle identity, or the selected V1 leaf's expected generation for
public V1-backed Fleet; otherwise no sealed snapshot is published.
Counts/totals
recompute, JSON pointers are canonical, and the snapshot's `appSpecSha256` and brief-payload digest
equal the values at its matching `attempt-started` ancestor. At attempt publication those are also
the top-level current refs; a later outcome may retain the input ref while installing a replanned
current spec. For public V1-backed Fleet they instead equal the uniquely selected leaf's eligible
current spec/payload. Its application/project resource keys and physical project equal the same
attempt or public selection's validated values, and
`inputBaseDir` equals the immutable target base. An
absent required path or stably read invalid payload is representable so the current definite asset
failure can be recorded; neither can be mistaken for successful provisioning. An unsafe or unstable
path does not produce a snapshot at all. Extraction is schema/ledger-role driven, never a heuristic
over arbitrary path-looking strings in `params`, notes, URLs, or generated arguments. Revisioned
host paths use the immutable input-base rule below; public legacy Fleet keeps its accepted path
resolution when no V1 lineage exists.

Model closure is explicit. A bounded GLTF/GLB inspector includes every safe relative buffer/image
URI as `model-sidecar`, rejects network, absolute, or traversing dependencies, and accepts an archive
only after proving it is self-contained. V1 rejects loose USD/USDA/USDC models until a bounded
dependency enumerator exists; it does not let an inner bake process read unmanifested references.
PLY/SPZ splats, panos, semantic/occupancy JSON, and KTX files are single-file inputs under their
kind-specific validators. This restriction applies only to sealed V1 routes (run attempts and
public V1-backed Fleet); unchanged legacy Fleet behavior remains available when no V1 lineage exists.

Disposition semantics are exact. `scaffolded` and `reused-project` apply only to the scaffold step;
`native-stage-*` applies only to `build_and_run`; ordinary generator steps use `executed-*`;
`not-attempted` follows a definite earlier stop; and `in-doubt` means the runner could not establish
completion. A successful tool return with the expected output bytes present is `confirmed`; a tool
with no file output uses `not-applicable`. The current compatibility case in which a generator
returns successfully but its expected output is absent remains `executed-success/unconfirmed` with
a diagnostic digest—it is not silently rewritten as a failure. `completedCount` counts only
`scaffolded`, `reused-project`, `native-stage-success`, and `executed-success` steps whose output is
`confirmed` or `not-applicable`. Failed, unconfirmed, not-attempted, and in-doubt steps do not count.

`projectWrites` is the private Fleet execution boundary's ordered record of selected-input writes.
Paths are canonical project-relative paths accepted by the receipt Gradle-input policy. `before`
and `after` are exact stable identities, with null representing absence; per-event no-op records are
rejected. Repeated writes to one path are legal only when they remain in global execution order and
form one exact chain: the first `before` equals the pre-attempt manifest identity, each later
`before` equals the preceding `after` for that path, and the last `after` equals the post-attempt
identity. Folding each path to its first/last identity and dropping a net restoration produces the
net write map; that map must equal the complete independently collected before/after manifest diff.
Every intermediate event comes from the locally injected write seam and is separately bounded; a
caller cannot submit an unverifiable intermediate hash. A nonempty valid chain that restores the
original generation is still recorded as `fleet-write-set`, not `unchanged`, because writes
occurred. Caller-shaped summaries are rejected; only the current injected Fleet-core result can be
strictly parsed, independently checked, and locally branded for publication.

`JsonObject` and every rich diagnostic/result field use the existing canonical-JSON value grammar:
only null, booleans, finite numbers, strings, dense arrays, and ordinary own-data-property objects;
no undefined, accessors, sparse arrays, custom prototypes, cycles, or non-finite numbers. The result
projection additionally caps nesting at 32, object keys at 1,024 per object, array elements at 4,096,
and its complete envelope at 4 MiB. Diagnostic strings are scrubbed to 4 KiB before entering it.

The exact public-result unions are:

```typescript
type BuildWorkCommonV1 = {
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

type BuildAppPublicResultV1 =
  | { status: "needs-authoring"; scaffold: AppSpec; fix: string;
      archetype?: string; archetypeWhy?: string }
  | { status: "plan-failed"; detail: JsonValue; fix: string }
  | (BuildWorkCommonV1 & {
      status: "failed" | "built-not-installed" | "built-no-capture";
      fix: string })
  | (BuildWorkCommonV1 & {
      status: "auto-judged-needs-look" | "built-needs-look" });

type LoopPublicOutcomeV1 =
  | { kind: "build"; status: "fail"; detail: string }
  | { inputIndex: number; criterionDigest: Sha256;
      kind: "structural" | "visual" | "logcat" | "perf";
      status: "pass" | "fail" | "unmeasurable" | "needs-look";
      detail: string | null; machineVerdict: string | null;
      recordedEvidence: boolean | null; failureClass: string | null;
      machineChecks: JsonValue[] };

type LoopIterationLogRowV1 = {
  iteration: number;
  outcomes: LoopPublicOutcomeV1[];
  capture: string | null;
  receiptId: Sha256 | null;
  receiptPath: string | null;
  ledger: string;
};

type LoopExitCommonV1 = {
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

type PicoLoopPublicResultV1 =
  | { status: "plan-failed"; iterations: 0; detail: JsonValue; fix: string }
  | (LoopExitCommonV1 & { status: "plan-failed"; detail: JsonValue; fix: string })
  | (LoopExitCommonV1 & { status: "budget-exhausted";
      failing: LoopPublicOutcomeV1[]; fix: string })
  | (LoopExitCommonV1 & { status: "accepted";
      ceiling: "structural" | "auto_judged"; acceptanceScope: string;
      fleetVisualVerdict: string; remainingLookObligation: Array<{
        artifact: string | null; whatToConfirm: string }>;
      honesty: string })
  | (LoopExitCommonV1 & { status: "built-needs-look";
      needsLook: LoopPublicOutcomeV1[]; remainingLookObligation: Array<{
        artifact: string | null; whatToConfirm: string }>;
      honesty: string })
  | (LoopExitCommonV1 & { status: "unmeasurable-acceptance";
      failing: LoopPublicOutcomeV1[]; fix: string })
  | (LoopExitCommonV1 & { status: "no-progress";
      failing: LoopPublicOutcomeV1[]; detail?: JsonValue; fix: string })
  | (LoopExitCommonV1 & { status: "failed";
      failing: LoopPublicOutcomeV1[]; fix: string })
  | (LoopExitCommonV1 & { status: "manual-repair-required";
      failing: LoopPublicOutcomeV1[]; detail?: JsonValue; fix: string });

type PreRunWorkflowFailureV1 =
  | { status: "plan-failed"; detail: JsonValue; fix: string }
  | { status: "plan-failed"; iterations: 0; detail: JsonValue; fix: string }
  | { status: "invalid-acceptance"; iterations: 0; fix: string };
```

Unknown top-level keys and fields from another status variant are rejected. `identity`, `detail`,
and the paired optional loop fields preserve their current conditional presence; the two archetype
strings occur together or are both absent. Loop `capture/receiptId/receiptPath` occur together after
Fleet ran; `perfTrend/perfEvidence` occur together when at least one perf sample exists. Every
string/array/value uses the bounds above. Non-null paths are canonical absolute, receipt fields
cross-match the revision's validated ref at publication, iteration rows are positive contiguous,
and criterion rows correspond to the immutable acceptance by index/digest. The build-failure row is
the only row without a criterion identity.

Build status booleans are closed: `failed` has `built:false`; `built-not-installed` has
`built:true/installed:false`; `built-no-capture` has `built:true/installed:true` and null receipt
triple; both needs-look statuses have `built:true/installed:true` and a non-null receipt triple.
Only `auto-judged-needs-look` sets `autoJudgedRecorded:true`; every other build status sets false.
The needs-look variants have no `fix`, and the three failure variants require it. Loop
status-specific fields follow only their shown intersection arm; optional `detail` exists only for
the current no-progress/manual-repair paths that return it.

`PreRunWorkflowFailureV1` is returned directly, without run coordinates or a public-result
snapshot, only when invalid acceptance or an invalid caller AppSpec prevents valid durable intent.
The same plan-failed shape may be snapshotted after revision zero when the planner itself fails.
`invalid-acceptance` is intentionally neither a stored workflow status nor a run-control status.

The build workflow admits only the build statuses listed in `BuildAppPublicResultV1`; the loop admits
only `plan-failed | budget-exhausted | accepted | built-needs-look |
unmeasurable-acceptance | no-progress | failed | manual-repair-required`. The same string appearing
in both workflows does not make their result shapes interchangeable.

The `sha256` and `bytes` in a `SnapshotRef` cover the complete canonical envelope above, excluding
only the single trailing newline used in the file. Snapshot envelopes do not contain their own
digest or byte length, avoiding a self-referential identity.

The reader opens snapshot leaves without following symbolic links, enforces the type-specific size
limit, checks stable descriptor metadata, requires canonical bytes and the expected strict envelope,
and recomputes both digest and length. A missing, malformed, oversized, swapped, or wrong-type core
snapshot makes the run store invalid; resume cannot continue from a partially rehydrated intent.

Throughout this document, `Sha256` matches `/^[a-f0-9]{64}$/`, `LowercaseUuidV4` matches the
canonical lowercase RFC 4122 version-4 form, and `CanonicalUtcTimestamp` must equal
`new Date(value).toISOString()` byte for byte. These are value grammars, not descriptive aliases.

## Revision envelope

Every revision is strict canonical JSON plus one newline. Unknown fields are rejected. The exact
top-level shape is:

```typescript
type ProjectLocatorV1 = {
  kind: "pico.project-locator";
  schemaVersion: 1;
  requestedProjectsRoot: string;
  physicalProjectsRoot: string;
  requestedProjectDir: string;
  physicalProjectDir: string;
  anchor: {
    requestedPath: string;
    physicalPath: string;
    device: string;
    inode: string;
  };
  missingSuffix: string[];
};

type RunRevisionV1 = {
  kind: "pico.workflow-run-revision";
  schemaVersion: 1;
  runId: LowercaseUuidV4;
  revision: number;
  revisionId: Sha256;
  parent: null | { revision: number; revisionId: Sha256 };
  createdAt: CanonicalUtcTimestamp;
  workflow: "pico-build-app" | "pico-loop";
  intent: {
    goal: SnapshotRefV1 & { kind: "goal" };
    acceptance: (SnapshotRefV1 & { kind: "acceptance" }) | null;
    initialSpec: (SnapshotRefV1 & { kind: "app-spec" }) | null;
    currentSpec: null | {
      snapshot: SnapshotRefV1 & { kind: "app-spec" };
      origin: "planner-scaffold" | "caller-authored" |
        "retained-lesson-repair" | "explicit-amendment";
      amendsRevision: number | null;
    };
    briefPayload: (SnapshotRefV1 & { kind: "brief-payload" }) | null;
    budget: null | {
      iterations: number;
      timeMin: number;
      toolCalls: "inert";
    };
    onFail: null | "replan" | "stop";
    execution: { fleetSettleSec: 16 };
  };
  target: {
    briefInput: string;
    briefId: string;
    app: string;
    executionSerial: "emulator-5554";
    inputBaseDir: string;
    briefPath: string;
    projectDir: string;
    projectLocator: ProjectLocatorV1;
    resourceKey: Sha256;
    projectResourceKey: Sha256;
    base: null | {
      runId: LowercaseUuidV4;
      revision: number;
      revisionId: Sha256;
    };
  };
  transition: TransitionV1;
  projectGeneration: ProjectGenerationStateV1;
  attemptInputs: (SnapshotRefV1 & { kind: "external-input" }) | null;
  compiler: CompilerOutcomeV1;
  receiptReferences: NativeReceiptRefV1[];
  autoJudgeEvidence: AutoJudgeEventRefV1 | null;
  iteration: IterationStateV1;
  publicResult: (SnapshotRefV1 & { kind: "public-result" }) | null;
  lifecycle: LifecycleV1;
  storedEvidenceCeiling: "structural" | "auto_judged";
};
```

All numbers called counts, indices, revisions, bytes, or milliseconds are finite safe non-negative
integers; `IterationStateV1.index` is positive and ledger event sequence numbers are non-negative.
`timeMin` is a finite number in the inclusive range `0..1440`. Every string has its named grammar and bound;
otherwise it is limited to 64 KiB, with diagnostic strings limited to 4 KiB.

Cross-field validation is part of the schema contract. `pico-build-app` requires
`acceptance/budget/onFail:null`; `pico-loop` requires a non-null acceptance ref, fully expanded
budget, and explicit `onFail`. `target.briefInput` is the bounded original caller string retained
solely to prove the compatibility mapping; its normalization must equal the goal snapshot and
`target.briefId` must be the unchanged `briefIdOf(target.briefInput)`,
`target.app` must equal `com.fleet.<briefId>`, and both target paths must be canonical absolute paths
for that ID. `target.projectDir` equals `target.projectLocator.requestedProjectDir` and the locator
must rederive exactly under the stable physical-path rules below. `resourceKey` is SHA-256 over
canonical JSON `{kind:"pico.application-resource",schemaVersion:1,app,serial}` using the exact
target app and execution serial; it is deliberately independent of `projectsRoot` spelling.
`projectResourceKey` is SHA-256 over canonical JSON
`{kind:"pico.physical-project-resource",schemaVersion:1,physicalProjectDir}` using the locator's
canonical physical project path; aliases of one physical directory therefore share it. The workflow-specific
lifecycle/status, receipt app, and public-result workflow/status must all agree. The stored AppSpec
remains the planner/caller value; fleet's established package rewrite to the target app is not
back-propagated into that immutable input snapshot. These are reader checks as well as publisher
preconditions.

`target.inputBaseDir` is the stable physical `realpath` of the server working directory captured at
new-target admission. A target-base child inherits it exactly. Revisioned V1 resolves a leading
`~/` against the canonical home directory, an absolute path directly, and every other external
host-file path against this stored base; the current process cwd is never consulted on resume.
IBL `ktxAssetPath` remains a separately validated safe relative path below the selected IBL base.
The external manifest repeats `inputBaseDir` and must match the target.

`target.base` is null only for a target proven new at admission. For an occupied target it exactly
equals the caller's `targetBase` and names the independently revalidated terminal predecessor HEAD
described above. Every read validates that immutable predecessor coordinate, its closed generation
basis, identical application/project resource keys and physical directory, and the acyclic
single-child application-resource lineage under the aggregate budgets. A reader rejects
a root revision whose recorded admission class and base disagree, a reused base, a branch, or a
cycle; it does not reclassify old bytes as a new target later.

Every revision-zero state, including one with `target.base`, begins with empty receipt references,
null auto-judge evidence, structural ceiling, compiler `not-run`, and iteration `not-run`. A child
may copy only the freshly observed target generation and its own caller-normalized intent; it never
copies predecessor evidence, result, compiler, or runtime fields.

`intent.briefPayload` is null exactly when `currentSpec` is null. Otherwise it names the strict
brief-payload envelope whose `id` equals `target.briefId`, whose `brief` equals
`target.briefInput` byte for byte, and whose schema-parsed `spec` equals the current AppSpec
snapshot. The object path is derived from the ref and stays immutable for receipt revalidation;
the canonical mutable `target.briefPath` is never substituted for it.

`attemptInputs` is null before an attempt. The `attempt-started` transition atomically publishes one
fresh external-input ref for its exact current AppSpec, brief payload, application/project resources, and
physical project. Every later revision belonging to that attempt retains the same ref; a state-only
plan/spec-amendment revision outside an attempt clears it, and a later attempt publishes a new ref.
An ordinary retry may therefore bind deliberately repaired asset bytes without rewriting history,
while no attempt can silently adopt bytes different from its own durable manifest. A target-base
child starts with null attempt inputs and never inherits a predecessor's manifest. If an
`iteration-completed` outcome installs a replanned current spec, readers validate the retained input
ref against that attempt's ancestor spec/payload, not the new spec that only a future attempt may
consume.

`intent.execution.fleetSettleSec` is always the literal 16 used by both current Door orchestrators.
The direct full-surface Fleet default of 12 is not inherited by these workflows and cannot drift
across resume.

The strict state unions are:

```typescript
type BoundedDiagnosticV1 = {
  code: string;
  detail: string;
  detailSha256: Sha256;
};

type ExternalPhaseV1 =
  | "fleet-build" | "scaffold" | "compiler" | "generator" | "native-build"
  | "install" | "asset-delivery" | "launch" | "capture" | "receipt-publication"
  | "visual-judge" | "mouse-bridge" | "panel-launch" | "panel-probe"
  | "panel-capture" | "acceptance-logcat" | "acceptance-structural"
  | "acceptance-perf" | "structural-ledger" | "replan";

type CompilerPhaseV1 =
  | "fleet-build" | "scaffold" | "compiler" | "generator"
  | "asset-delivery" | "native-build";

type StructuralLedgerResultV1 =
  | { status: "recorded"; seq: number }
  | { status: "not-recorded"; reason: BoundedDiagnosticV1 };

type BriefGenerationV1 =
  | { status: "absent" }
  | { status: "observed"; bytes: number; sha256: Sha256 };

type ProjectInputGenerationV1 =
  | { status: "absent" }
  | { status: "observed"; directory: {
      physicalPath: string;
      device: string;
      inode: string;
    }; identity: {
      kind: "pico.gradle-input-generation";
      schemaVersion: 1;
      policy: "pico-native-receipt-gradle-input-v1";
      projectDir: string;
      algorithm: "sha256";
      sha256: Sha256;
      entryCount: number;
      totalBytes: number;
    } }
  | { status: "unobservable"; reason: string; reasonSha256: Sha256 };

type TargetGenerationV1 = {
  brief: BriefGenerationV1;
  project: ProjectInputGenerationV1;
};

type ProjectGenerationStateV1 = {
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

type CompilerOutcomeV1 =
  | { status: "not-run" }
  | { status: "succeeded"; ledger: SnapshotRefV1 & { kind: "compiler-ledger" };
      plannedCount: number; completedCount: number; elapsedMs: number;
      executionDisposition: "definitely-completed" }
  | { status: "failed"; ledger: (SnapshotRefV1 & { kind: "compiler-ledger" }) | null;
      phase: CompilerPhaseV1; failure: BoundedDiagnosticV1;
      plannedCount: number; completedCount: number; elapsedMs: number;
      executionDisposition: "definitely-completed" }
  | { status: "in-doubt";
      ledger: (SnapshotRefV1 & { kind: "compiler-ledger" }) | null;
      phase: CompilerPhaseV1; reason: BoundedDiagnosticV1;
      plannedCount: number | null; completedCount: number | null; elapsedMs: number | null;
      executionDisposition: "in-doubt" };

type CriterionOutcomeV1 = {
  inputIndex: number;
  criterionDigest: Sha256;
  kind: "structural" | "visual" | "logcat" | "perf";
  status: "pass" | "fail" | "unmeasurable" | "needs-look";
  detail: string | null;
  machineVerdict: string | null;
  recordedEvidence: boolean | null;
  failureClass: string | null;
  machineChecks: JsonValue[];
};

type PerfSampleV1 = {
  inputIndex: number;
  criterionDigest: Sha256;
  measurement: {
    iteration: number;
    p5: number;
    p10: number | null;
    p50: number | null;
    avg: number;
    jankWindows: number | null;
    reportPath: string | null;
  };
};

type IterationStateV1 =
  | { status: "not-run"; nextIndex: 1; completedCount: 0;
      previousFailureSignature: null }
  | { status: "blocked"; index: number; completedCount: number; nextIndex: number;
      failure: BoundedDiagnosticV1; previousFailureSignature: string | null;
      structuralLedger: StructuralLedgerResultV1 }
  | { status: "completed"; index: number; completedCount: number; nextIndex: number;
      outcomes: CriterionOutcomeV1[]; previousFailureSignature: string | null;
      perfSamples: PerfSampleV1[]; structuralLedger: StructuralLedgerResultV1 };

type LifecycleV1 =
  | { status: "open"; phase: "ready-to-plan" | "awaiting-authoring" | "ready-to-build";
      publicStatus: "needs-authoring" | null }
  | { status: "running"; phase: "attempt-started" | "attempt-in-doubt";
      attemptId: LowercaseUuidV4 }
  | { status: "paused"; publicStatus: PausedPublicStatusV1 }
  | { status: "blocked"; reason: "external-state-conflict";
      attemptId: LowercaseUuidV4 }
  | { status: "terminal"; publicStatus: TerminalPublicStatusV1 };
```

For every `BoundedDiagnosticV1`, `detail` is the scrubbed at-most-4-KiB projection and
`detailSha256` covers the complete bounded pre-truncation diagnostic string. The native public
`reason` exception below retains its established larger bound while using this same projection
rule.

Each `PerfSampleV1` matches one perf outcome by `inputIndex/criterionDigest`; its measurement keeps
the current perf-trail fields with absent optional values expanded to null. All measurements are
finite, `iteration` equals the enclosing iteration index, and a non-null report path is a bounded
canonical absolute path. Samples preserve evidence-safe evaluation order, including duplicate perf
criteria. Public `perfTrend` reconstructs the current object shape by omitting null optional fields
and the internal criterion identity; it does not collapse duplicate samples.

`StructuralLedgerResultV1.seq` is a non-negative integer. `CompilerPhaseV1` is the shown strict
pre-receipt subset of `ExternalPhaseV1`; its `asset-delivery` arm describes Fleet's project asset
staging, while an after-install native delivery failure remains compiler phase `native-build` and
attempt phase `asset-delivery`. Neither parser accepts an unlisted phase.
`PausedPublicStatusV1` and `TerminalPublicStatusV1` are exactly the status mappings listed below.

For a completed iteration, outcomes are in evidence-safe evaluation order and correspond one-for-one
to the acceptance criteria by `{inputIndex,criterionDigest}`. A failure before criterion evaluation
uses `blocked`, not a synthetic criterion. Its public `iterationsLog` projection recreates the
current single `{kind:"build",status:"fail"}` row. `nextIndex`, `completedCount`, and the previous
failure signature make the latest revision sufficient to continue; earlier immutable iteration
revisions remain the authority for reconstructing the full log and perf trail.

`iteration-completed` means the definite attempt iteration, including any safe replan, reached a
durable continuation boundary; its `IterationStateV1` may therefore be either `blocked` or
`completed`. The transition name does not convert a blocked build into a criterion result.

Revision zero has `parent: null`. Every later parent is exactly revision `n - 1` and names the
recomputed parent `revisionId`. `revisionId` is SHA-256 over the canonical envelope with only
`revisionId` omitted. The timestamp is observational and is never used to reorder revisions or
decide lock ownership.

A revision repeats the bounded effective intent, target, current spec, accumulated validated
receipt refs, and lifecycle state. It is a complete state checkpoint, not a patch that requires
guessing missing values. Its transition union is exact:

```typescript
type ExternalMutationDispositionV1 = "none" | "possible" | "confirmed";

type TransitionV1 =
  | { type: "created" }
  | { type: "plan-completed";
      outcome: "awaiting-authoring" | "ready-to-build" | "plan-failed";
      diagnostic: BoundedDiagnosticV1 | null }
  | { type: "spec-authored"; previousSpec: Sha256; currentSpec: Sha256 }
  | { type: "spec-amended"; previousSpec: Sha256 | null; currentSpec: Sha256 }
  | { type: "attempt-started"; attemptId: LowercaseUuidV4;
      phase: "build" | "loop-iteration"; iteration: number | null;
      generation: TargetGenerationV1; inputs: Sha256 }
  | { type: "attempt-in-doubt"; attemptId: LowercaseUuidV4;
      phase: ExternalPhaseV1; reason: BoundedDiagnosticV1;
      externalMutationDisposition: "possible" | "confirmed" }
  | { type: "attempt-paused"; attemptId: LowercaseUuidV4;
      phase: ExternalPhaseV1; publicStatus: PausedPublicStatusV1;
      failure: BoundedDiagnosticV1;
      externalMutationDisposition: ExternalMutationDispositionV1 }
  | { type: "attempt-conflicted"; attemptId: LowercaseUuidV4;
      reason: BoundedDiagnosticV1; observed: TargetGenerationV1;
      externalMutationDisposition: ExternalMutationDispositionV1 }
  | { type: "iteration-completed"; attemptId: LowercaseUuidV4;
      iteration: number; next: "ready-to-build";
      externalMutationDisposition: ExternalMutationDispositionV1 }
  | { type: "run-terminal"; attemptId: LowercaseUuidV4;
      publicStatus: TerminalPublicStatusV1;
      externalMutationDisposition: ExternalMutationDispositionV1 }
  | { type: "policy-terminal";
      reason: "time-budget-exhausted" | "iteration-budget-exhausted";
      publicStatus: "budget-exhausted" };
```

`policy-terminal` is the only terminal transition without an `attemptId`; it handles the existing
case where the invocation's `timeMin` expires after planning or a durable iteration checkpoint but
before the next attempt begins. It also handles a resumed paused run whose last definite attempt
already consumed the total iteration budget. Iteration-budget exhaustion decided in the outcome of
the final definite attempt uses that attempt's `run-terminal` transition.

An outcome transition must match the current live attempt ID. `attempt-started.generation` must
equal `projectGeneration.lastAttempt.before`, and `attempt-started.inputs` must equal the top-level
external-input ref digest; its `after` is null. A definitely completed outcome
must carry the same attempt ID and a non-null `after`. An attributed `attempt-paused`,
`iteration-completed`, or `run-terminal` makes `expected` equal that after-generation and records
the matching locally validated Fleet write-set proof. `attempt-conflicted` records the observed generation
but leaves `expected` at the pre-attempt generation and sets attribution null; it is never an
automatic resume precondition.
Every attempt outcome persists the orchestration-wide external-mutation disposition, not merely
Fleet's contribution. The accumulator starts at `none`; invoking an operation that may mutate the
project, device/logcat state, perf-report files, receipt/ledger store, or captures raises it to
`possible`, and a definite acknowledgement of any such mutation raises it permanently to
`confirmed`. Fleet's private envelope contributes its exact disposition; pre-Fleet logcat reset,
post-Fleet acceptance/perf calls that write artifacts, and `record_verification` contribute through
the same injected boundary. Pure planning, validation, and read-only queries do not. An in-doubt
outcome cannot say `none`; a known acknowledged mutation remains `confirmed` for every later
observer, while an invoked but wholly unconfirmed mutation remains `possible`. A definite outcome
may use all three values because process completion can be known even when a device/tool mutation
is not.
`policy-terminal` has no attempt and implies `none`.
`attempt-started` and `attempt-in-doubt` require `after:null` and `attribution:null`. An attributed
outcome uses `status:"unchanged"` only when the validated Fleet write-event list is empty. Any
nonempty validated chain uses `fleet-write-set` and requires the matching compiler-ledger digest,
even when its folded net map restores the original generation; a receipt-bearing chain instead uses
`receipt-and-fleet-write-set` and additionally requires the exact receipt ID.
`attempt-paused`, `run-terminal`, and `policy-terminal` must carry a `publicResult` whose envelope
workflow/status matches the lifecycle and transition. `plan-completed/awaiting-authoring` stores the
`needs-authoring` result, `plan-completed/plan-failed` stores the `plan-failed` result, and
`plan-completed/ready-to-build` requires `publicResult:null`. All other transitions require null.
Schema and publication logic reject optimistic compiler, receipt, iteration, result, or terminal
fields that are inconsistent with those invariants.

`created`, `spec-authored`, `spec-amended`, and `plan-completed` require `attemptInputs:null`.
`attempt-started` requires the fresh validated external-input ref. `attempt-in-doubt`,
`attempt-conflicted`, `attempt-paused`, `iteration-completed`, and an attempt-derived `run-terminal`
retain that exact ref from their matching attempt ID; they cannot replace it with a later
observation. A no-attempt `policy-terminal` has null. A subsequent state-only amendment clears the
prior attempt ref before any later attempt collects another. The reader follows these links rather
than treating the latest mutable asset bytes as historical evidence.

Transition/lifecycle pairing is closed: `created`, `spec-authored`, and `spec-amended` are
`open/ready-to-plan`; successful `plan-completed` is `open/awaiting-authoring` or
`open/ready-to-build`, while failed planning is paused `plan-failed`; `attempt-started` and
`attempt-in-doubt` are the corresponding running phases; `attempt-paused` is paused;
`attempt-conflicted` is blocked `external-state-conflict`;
`iteration-completed` is `open/ready-to-build`; and `run-terminal`/`policy-terminal` are terminal.
`plan-completed/plan-failed` requires a non-null diagnostic, while its other outcomes require null.
No other transition/lifecycle pair validates.

## Compiler, receipt, iteration, and lifecycle state

Compiler outcome is a strict union:

- `not-run`;
- `succeeded`, with a compiler-ledger snapshot ref, planned step count, completed step count, and
  bounded phase timing; or
- `failed`, with any privately validated partial-ledger snapshot, named phase/failure class,
  bounded detail, detail digest, and safely observed completed count; or
- `in-doubt`, with the named compiler phase, bounded reason, and any partial ledger/count/timing that
  the private boundary definitely reported before ambiguity; an outer response loss uses null
  ledger/count/timing rather than inventing them.

Fleet's additive structured result and the native receipt producer both report
`executionDisposition:"definitely-completed" | "in-doubt"`, an exact `phase`, and
`externalMutationDisposition:"none" | "possible" | "confirmed"` from their runner boundaries.
Fleet also returns the exact post-rewrite ledger/write-set snapshot when that snapshot is known;
the run layer brands it only after strict origin-bound parsing and independent filesystem checks.
The run layer does not infer process completion, write attribution, or
quiescence from notes, exit-shaped booleans, unchanged inputs, elapsed time, or a caller-shaped
object. A timeout, transport loss, or unconfirmed termination is `in-doubt` even when a direct child
kill was requested. Loss of the shared `executeFleetBuild` core's outer promise/result before a
valid structured envelope is phase `fleet-build` and does not invent a more specific inner phase or
compiler count; durable out-of-band phase reporting is not added in V1.

The implementation extracts the current Fleet handler into one exported, dependency-injected
`executeFleetBuild` core. The existing public `fleet_build` MCP wrapper continues to accept ID lookup
and serialize its current result shape plus additive diagnostics. Before any per-brief mutating
phase, that wrapper derives the actual default/custom `projectsRoot` locator, acquires the same
application-resource and physical-project locks used by V1 in that order, and revalidates the
locator. Before publishing an execution marker it performs the same complete streaming root,
run-directory, revision, and core-CAS scan with the exact aggregate ceilings used by admission and
`pico_next`. An exceeded ceiling returns `limit-exceeded`; any unknown/unsafe root candidate or
malformed/corrupt run that prevents a complete no-lineage proof returns `invalid-store`. Both make
zero marker, mutable resolver, and core calls and never fall back to legacy bytes.
A live/partial writer whose application or physical-project resource cannot be safely classified
returns `run-busy`. The no-lineage proof is two-dimensional: legacy fallback is permitted only when
the complete scan proves that no valid V1 lineage has either the requested application-resource key
or the requested physical-project-resource key. A valid committed run whose two keys both differ is
classified and does not suppress a clean requested-ID legacy fallback. A run with a different
application key but the same physical-project key returns `target-conflict` with zero marker,
mutable resolver, or core call; releasing its project lock earlier does not authorize a later
legacy writer to mutate that V1-owned project.

Under those locks, a unique valid **terminal** leaf whose planner-completed
current spec is eligible for this compatibility build resolves to its immutable run-owned
brief-payload CAS path. This
V1-backed route requires the stored locator and the call's freshly resolved locator to validate
independently. Their `physicalProjectDir` values must be identical; their requested spelling and
anchor representation need not be. A genuinely different custom root is `target-conflict`, while a
stable lexical/symlink alias of the same physical project is accepted. It then re-observes the compatibility brief and selected project
identity under both resource locks and requires them to equal the leaf's stored
`projectGeneration.expected`; an unobservable or mismatched locator/generation returns a per-brief
`target-conflict` with zero core call. The wrapper also collects one fresh bounded external-input
manifest, seals the view, and passes only its locally branded `v1-backed-fleet` capability; public
Fleet does not append a run revision.
Eligibility means a terminal lifecycle with a non-null current spec and matching brief payload whose
digest reached the most recent successful `plan-completed/ready-to-build`. Public Fleet is an
out-of-band writer and has no authority to advance `projectGeneration.expected`; it therefore never
executes against an open or paused leaf. Such a leaf returns `target-conflict` with zero manifest,
marker, resolver, or core call and an additive `coordinationContinuation` naming its workflow plus
exact `{runId,expectedRevision}` coordinate. Running, in-doubt, blocked, `ready-to-plan`,
`awaiting-authoring`, plan-failed, retained-lock, or superseded/unplanned-spec leaves are likewise
not eligible. If any V1 lineage on either requested resource key cannot yield exactly that one safe
terminal leaf, Fleet fails that brief instead of falling back to stale mutable bytes. Only when the
complete scan proves no V1 lineage for both the requested application and physical-project
resources does the unchanged user-store-then-corpus lookup order apply.
Thus a brief ID returned by a completed V1 Door
remains consumable by the public ID-only wrapper without recreating
`~/.pico-mcp/briefs/<id>.json` or overwriting an unacknowledged source edit.

With no V1 lineage, a caller-supplied `projectsRoot` retains its accepted lexical
`<root>/fleet-<id>-native` mapping and mutable user/corpus lookup. The application-resource key is
independent of that root, so two concurrent legacy calls for the same ID but different roots cannot
both begin execution. Two different IDs/apps whose locators resolve to one physical project also
serialize on the project-resource lock. A live or retained V1 owner for that ID likewise blocks every custom-root
spelling before the core runs. The locator is still bound into the private capability so the core
cannot mutate a path other than the one the wrapper resolved.

Door run orchestration calls the same core in run-payload mode while already holding its
run/application/physical-project execution owners. Public V1-backed Fleet uses the same sealed mode;
only no-lineage legacy Fleet uses the separate mutable compatibility capability below. The core
cannot be called without one locally branded capability, still uses Fleet's full-surface inner
client, receives no `runId`, and returns this exact
internal union:

```typescript
declare const fleetExecutionInputsBrand: unique symbol;
declare const fleetSealedInputViewBrand: unique symbol;
declare const legacyFleetExecutionBrand: unique symbol;

type FleetSealedInputViewV1 = {
  manifestSha256: Sha256;
  physicalRoot: string;
  close(): void;
  readonly [fleetSealedInputViewBrand]: true;
};

type FleetExecutionInputsCapabilityV1 = {
  kind: "pico.fleet-execution-inputs";
  schemaVersion: 1;
  mode: "run-payload" | "v1-backed-fleet";
  app: string;
  serial: "emulator-5554";
  resourceKey: Sha256;
  projectResourceKey: Sha256;
  projectLocator: ProjectLocatorV1;
  inputBaseDir: string;
  runLockToken: LowercaseUuidV4 | null;
  applicationLockToken: LowercaseUuidV4;
  projectLockToken: LowercaseUuidV4;
  attemptId: LowercaseUuidV4;
  briefPayloadSha256: Sha256;
  externalInputSha256: Sha256;
  externalInput: ExternalInputSnapshotV1;
  sealedView: FleetSealedInputViewV1;
  readonly [fleetExecutionInputsBrand]: true;
};

type LegacyFleetExecutionCapabilityV1 = {
  kind: "pico.legacy-fleet-execution";
  schemaVersion: 1;
  mode: "legacy-fleet";
  app: string;
  serial: "emulator-5554";
  resourceKey: Sha256;
  projectResourceKey: Sha256;
  projectLocator: ProjectLocatorV1;
  applicationLockToken: LowercaseUuidV4;
  projectLockToken: LowercaseUuidV4;
  attemptId: LowercaseUuidV4;
  briefPath: string;
  assetBaseDir: string;
  briefPayloadSha256: Sha256;
  briefPayload: { id: string; brief: string; spec: AppSpec };
  readonly [legacyFleetExecutionBrand]: true;
};

type FleetCoreCapabilityV1 =
  | FleetExecutionInputsCapabilityV1
  | LegacyFleetExecutionCapabilityV1;

type FleetCompilerSummaryV1 = {
  status: "not-run";
} | {
  status: "succeeded";
  ledger: CompilerLedgerSnapshotV1;
  plannedCount: number;
  completedCount: number;
  elapsedMs: number;
} | {
  status: "failed";
  ledger: CompilerLedgerSnapshotV1 | null;
  phase: CompilerPhaseV1;
  failure: BoundedDiagnosticV1;
  plannedCount: number;
  completedCount: number;
  elapsedMs: number;
} | {
  status: "in-doubt";
  ledger: CompilerLedgerSnapshotV1 | null;
  phase: CompilerPhaseV1;
  reason: BoundedDiagnosticV1;
  plannedCount: number | null;
  completedCount: number | null;
  elapsedMs: number | null;
};

type FleetReceiptSummaryV1 = {
  status: "recorded";
  receiptId: Sha256;
  receiptPath: string;
  capturePath: string;
  sourceCapturePath: string;
  captureSha256: Sha256;
  evidenceType: "structural";
  lookRequired: true;
};

type FleetResultV1 = {
  id: string;
  built: boolean;
  installed: boolean;
  concluded: boolean;
  verdict: string | null;
  artifact: string | null;
  receipt: FleetReceiptSummaryV1 | null;
  verificationRoute: JsonValue | null;
  visualExpectation: JsonValue | null;
  visualClaim: string | null;
  splatAssets: JsonValue | null;
  confidence: number | null;
  visualChecks: JsonValue[];
  visualJudgeNote: string | null;
  visualLedger: JsonValue | null;
  visualJudgeArtifact: string | null;
  panelEvidence: JsonValue | null;
  panelArtifact: string | null;
  nativeFailure: null | {
    stage: NativeFleetFailureStageV1;
    reason: string;
    completedStages: string[];
  };
  externalImplementation: JsonValue | null;
  notes: string[];
};

type FleetInputBindingV1 =
  | { mode: "sealed"; briefPayloadSha256: Sha256;
      externalInputSha256: Sha256 }
  | { mode: "legacy-mutable"; briefPayloadSha256: Sha256;
      externalInputSha256: null };

type FleetExecutionEnvelopeV1 =
  | { kind: "pico.fleet-execution"; schemaVersion: 1;
      inputBinding: FleetInputBindingV1; resourceKey: Sha256; projectResourceKey: Sha256;
      physicalProjectDir: string;
      executionDisposition: "definitely-completed";
      phase: "complete" | ExternalPhaseV1;
      externalMutationDisposition: "none" | "possible" | "confirmed";
      compiler: FleetCompilerSummaryV1;
      definiteReceipt: FleetReceiptSummaryV1 | null;
      result: FleetResultV1 }
  | { kind: "pico.fleet-execution"; schemaVersion: 1;
      inputBinding: FleetInputBindingV1; resourceKey: Sha256; projectResourceKey: Sha256;
      physicalProjectDir: string;
      executionDisposition: "in-doubt";
      phase: ExternalPhaseV1;
      externalMutationDisposition: "possible" | "confirmed";
      compiler: FleetCompilerSummaryV1;
      definiteReceipt: FleetReceiptSummaryV1 | null;
      reason: BoundedDiagnosticV1 };
```

`FleetResultV1` is the exact normalized one-brief form of Fleet's current result. Optional current
fields expand to null, strings/arrays and every `JsonValue` obey the bounds above, every non-null
artifact/receipt/panel path is canonical absolute, the receipt summary cross-fields agree, and the
ID must equal the run target. `nativeFailure` is non-null only for a definite native-stage failure.
The internal form has no run coordinates. The legacy public wrapper may omit its historically
optional null fields when projecting the unchanged Fleet result. `visualExpectation`,
`visualClaim`, and `splatAssets` are retained explicitly because the accepted public Fleet record
already exposes them; none is evidence authority.

`FleetExecutionInputsCapabilityV1` is an in-process branded capability, not JSON accepted from an
MCP caller. The factory retains it in a private identity set and creates it only after the current
run/application/project owner tokens required by its mode, physical locator, application/project
resource keys, payload digest, external manifest digest, sealed attempt-private input view, app,
serial, and attempt ID all agree. `run-payload` requires all three owners;
`v1-backed-fleet` requires the application and project owners and a null run token. The core checks
that identity and every still-current owner immediately
before work, consumes only the embedded validated input resolver, and rejects a cloned/forged,
wrong-token, wrong-path, or stale capability with zero inner calls. For a revisioned attempt,
`externalInputSha256` equals the durable `attemptInputs` ref; public V1-backed Fleet uses the same
bounded manifest/capability without claiming a run revision. Every observed external file—including
semantic and occupancy JSON—is copied and independently rehashed into the sealed view before the
capability exists. Original descriptors close after the stable copies validate. Consumers read only
the sealed copies, which become read-only before `attempt-started`/the public execution marker. A
definite return validates every consumed sealed file against the manifest. It never recollects the
caller/corpus source paths after sealing: later edits to those originals cannot alter this attempt
and are eligible only for a fresh manifest on a later attempt. A sealed-view mutation or an
unprovable consumption result is failure-shaped and never presents the resulting artifact/receipt
as bound to the immutable manifest.

No-lineage legacy Fleet instead receives `LegacyFleetExecutionCapabilityV1`. Its factory uses the
accepted user/corpus lookup/read/parse behavior once, binds the exact application/project owners and
locator, hashes the exact brief-file bytes that produced the parsed payload as
`briefPayloadSha256`, and retains the accepted mutable asset-base/path resolver. It adds no
canonical-file, symlink, size, or model-closure requirement. It does not create an
`ExternalInputSnapshotV1`, apply V1 model-closure/2-GiB restrictions, or claim immutable external
input authority. Current missing/invalid/hand-authored preflight skips remain wrapper behavior and
return before the marker/core. This preserves legacy resolution while adding only coordination and
path authorization.

Every Fleet envelope repeats the capability's payload binding, physical project, and both resource
keys. Sealed modes require a non-null external-input digest; no-lineage legacy requires
`inputBinding.mode:"legacy-mutable"` and null external digest. Any mismatch is an invalid private
result and cannot populate revisioned compiler, receipt, or public-result state.
`FleetSealedInputViewV1` is an opaque nominal handle whose brand indexes the factory's private
sealed-file resolver registry; its methods and paths are not caller JSON and cannot be
reconstructed from the visible fields.

`FleetCompilerSummaryV1` is a complete disposition, not a bag of nullable counts. The run layer
publishes any strict ledger envelope into CAS and maps the summary to `CompilerOutcomeV1` without
inferring failure/success from Fleet booleans or notes. A definite envelope with
`phase:"complete"` means every selected Fleet phase returned definitely; it does not mean its
visual verdict passed. A definite failure-shaped result uses the exact last non-complete phase.
An in-doubt envelope has no workflow `result`, but `definiteReceipt` preserves a receipt that was
already published and independently validated before a later ambiguous phase. It is non-null iff
that receipt publication was definitely reported; before-receipt ambiguity requires null. A
definite envelope's `definiteReceipt` must equal its non-null result receipt, or both are null.
An execution-definite envelope cannot carry a compiler `in-doubt` summary. An in-doubt envelope
before receipt publication carries compiler `in-doubt` at the mapped compiler phase (an
unlocalized outer loss uses `fleet-build` with null ledger/count/timing); an in-doubt envelope after
a definite receipt carries compiler `succeeded` plus that exact `definiteReceipt`. A definite
compiler failure cannot be paired with a later receipt or post-receipt phase. These cross-field
rules are strict parser checks, not orchestration conventions.

The definite phase mapping is closed. Brief/payload/classifier, execution-route, package-rewrite,
semantic-placement, or other pre-scaffold validation stops at `fleet-build`; missing/planning,
provisioning, or delivery of declared assets stops at
`asset-delivery`; scaffold and ordinary
generator failures use their same-named phases; the native mapping is defined below; and definite
judge, bridge, panel, acceptance, structural-ledger, or replan failures use their exact listed
phase. `phase:"complete"` is permitted only when every selected phase returned definitely. A
non-complete phase does not by itself imply a public failure status—for example, a definite
post-receipt visual-judge failure still preserves the receipt and may honestly finish as
`built-needs-look`. Compiler state is mapped independently: a stop before compiler/scaffold work is
`not-run`, a compiler-phase stop is `failed`, pre-receipt ambiguity is `in-doubt`, and a definite
receipt keeps compiler `succeeded` across later phases.

The core constructs the post-rewrite planned ledger before invoking its first project-mutating
scaffold or asset operation. From that boundary onward, definite failure or ambiguity returns the
privately observed partial ledger and ordered write events; `compiler:not-run` is permitted only
before any project mutation was invoked. This lets a definite scaffold/asset failure either prove
an attributable paused generation or fail as `attempt-conflicted`; it cannot lose known writes and
then promote the resulting project optimistically.

The locally injected executor is the only source of this envelope. After strict parsing, the run
layer independently validates the filesystem write set and receipt and brands that local
observation; neither public invocation input nor a previously serialized Fleet response can be
submitted as authority.

The native producer's additive result is independently exact:

```typescript
type NativeFleetFailureStageV1 =
  | "source-identity" | "build" | "build-input-continuity"
  | "apk-resolution" | "apk-publication" | "apk-inspection"
  | "install" | "installed-byte-identity" | "after-install"
  | "device-identity" | "launch" | "pid" | "foreground"
  | "capture" | "capture-publication" | "receipt-publication";

type NativeFleetExecutionResultV1 =
  | { status: "recorded"; executionDisposition: "definitely-completed";
      phase: "receipt-publication"; externalMutationDisposition: "confirmed";
      built: true; installed: true; receipt: PublishedNativeRunReceipt;
      completedStages: string[] }
  | { status: "failed"; executionDisposition: "definitely-completed";
      phase: ExternalPhaseV1;
      externalMutationDisposition: "none" | "possible" | "confirmed";
      stage: NativeFleetFailureStageV1; built: boolean; installed: boolean;
      reason: string; failure: BoundedDiagnosticV1; completedStages: string[] }
  | { status: "in-doubt"; executionDisposition: "in-doubt";
      phase: ExternalPhaseV1; externalMutationDisposition: "possible" | "confirmed";
      stage: NativeFleetFailureStageV1; built: boolean; installed: boolean;
      reason: string; diagnostic: BoundedDiagnosticV1; completedStages: string[] };
```

Native source/build/APK stages map to `native-build`; install and installed-byte stages to
`install`; the injected delivery callback to `asset-delivery`; device/PID/foreground/launch stages
to `launch`; capture-file materialization to `capture`; and final receipt CAS publication to
`receipt-publication`. A timeout, disconnect, or requested kill whose scoped process-tree
termination is not confirmed is in-doubt at the current phase. Exact stage details remain bounded
diagnostics. Receipt v1 itself is unchanged.

The recorded and failed variants retain every accepted-base field (`status`, `built`, `installed`,
`receipt` or `stage/reason`, and `completedStages`) byte-shape compatibly; the disposition,
external phase, and bounded diagnostic are additive. `reason` is the current bounded public string,
retaining the accepted producer's existing 64 KiB command-tail bound. Its paired diagnostic carries
at most the first 4 KiB after ordinary scrubbing while `detailSha256` covers the complete retained
reason, so the additive bound does not truncate or redefine the public field. The new in-doubt
variant uses the same detailed native stage plus the mapped outer phase and cannot be treated as
`failed`.

Attempt disposition and compiler outcome are independent, but the ledger's `build_and_run` step
covers the complete native receipt stage—build, install, launch/session, capture, and receipt
publication. Therefore a definite native failure is compiler `failed/native-build`, and an
ambiguity anywhere before receipt publication is compiler `in-doubt/native-build` while
`attempt-in-doubt` retains the more precise install/launch/capture/receipt phase. Only ambiguity
after a recorded receipt—visual judge, mouse/panel, acceptance, structural ledger, or replan—keeps
compiler `succeeded`. No late phase erases a known partial ledger, and no compiler summary turns a
later attempt ambiguity into a definite workflow outcome.

If the native stage becomes ambiguous after known generator steps, the compiler outcome retains the
partial ledger with `build_and_run` marked in-doubt plus only the counts already definite. Compiler
`succeeded` requires a recorded receipt and no failed, in-doubt, or not-attempted ledger step.
`executed-success/unconfirmed` is permitted for current compatibility, excluded from
`completedCount`, and may therefore leave `completedCount < plannedCount` even on compiler success.

For a definitely completed attempt, the orchestrator recollects the project generation. An
unchanged selected-input identity is attributable without write records. A changed identity is
attributable only when the complete before/after manifest diff equals Fleet's validated write set;
a receipt-bearing result must additionally have an after identity exactly equal to that receipt's
unchanged receipt-v1 Gradle-input identity. The canonical user-brief generation must remain exactly
unchanged because V1 never writes it. The private boundary must separately prove that every consumed
descriptor/materialized file retained the attempt manifest identity; it does not re-read the
original external source paths. Any extra, missing, unobservable, or mismatched project/brief change
commits the durable `attempt-conflicted` outcome rather than promoting arbitrary bytes. This check
governs successful and failed definite runner outcomes alike.

Subproject 3 records a summary of one compiler attempt. It does not introduce stable compiler step
IDs or authorize reuse of an old step; those belong to change-aware iteration v1.

A stored receipt reference contains only:

```json
{
  "kind": "pico.native-run-receipt",
  "schemaVersion": 1,
  "app": "com.fleet.door123",
  "receiptId": "<64 lowercase hex>",
  "captureSha256": "<64 lowercase hex>"
}
```

That object is `NativeReceiptRefV1`; it has exactly those five keys and their shown literal/value
grammars. At most six refs appear, in first-publication order, with no duplicate receipt ID.

```typescript
type NativeReceiptRefV1 = {
  kind: "pico.native-run-receipt";
  schemaVersion: 1;
  app: string;
  receiptId: Sha256;
  captureSha256: Sha256;
};
```

Caller paths and caller-authored receipt-shaped values are never persisted as authority. A receipt
ref may be added only through the injected historical receipt validator and only when app,
receipt ID, and capture identity agree.

Iteration state is `not-run`, `blocked`, or `completed` as defined in the strict union. A completed
outcome records its positive iteration index and exactly one ordered result per acceptance criterion
using the current honest vocabulary: `pass`, `fail`, `unmeasurable`, or `needs-look`. Reader
validation requires the outcome count and criterion identities to agree with the immutable
acceptance snapshot.

Lifecycle is a strict union:

- `open` for `ready-to-plan`, `awaiting-authoring`, or `ready-to-build`;
- `running` for one committed attempt, including an explicit in-doubt phase;
- `paused` for a retryable plan/build/install/capture failure, unmeasurable acceptance,
  no-progress, or manual repair; or
- `blocked` for one definitely completed attempt whose resulting mutable generation could not be
  attributed safely; or
- `terminal` for a completed current public result, including `accepted`,
  `built-needs-look`, `auto-judged-needs-look`, `budget-exhausted`, or an explicit stopped result.

Terminal runs cannot be reopened. A matching resume performs no state write or external call and
replays the immutable stored public result as defined below. A different goal, acceptance set, or
execution policy starts a new run and uses `targetBase` only when the occupied current leaf is an
eligible terminal base. An ordinary paused/open leaf remains explicitly resumable but cannot be
silently abandoned; the caller must continue it or choose a different target. Blocked and in-doubt
runs cannot be reopened or used as a target base.

The current public statuses map without renaming:

- Door 1 `needs-authoring` is open; `plan-failed`, `failed`, `built-not-installed`, and
  `built-no-capture` are paused; `built-needs-look` and `auto-judged-needs-look` are terminal.
- Loop `plan-failed`, `unmeasurable-acceptance`, `no-progress`, and
  `manual-repair-required` are paused; `accepted`, `built-needs-look`, `budget-exhausted`, and an
  `onFail:"stop"` `failed` result are terminal.
- `invalid-acceptance` is rejected before run creation because there is no valid immutable intent
  to store.

These lists are the exact persisted aliases:

```typescript
type PausedPublicStatusV1 =
  | "plan-failed" | "failed" | "built-not-installed" | "built-no-capture"
  | "unmeasurable-acceptance" | "no-progress" | "manual-repair-required";

type TerminalPublicStatusV1 =
  | "built-needs-look" | "auto-judged-needs-look"
  | "accepted" | "budget-exhausted" | "failed";
```

`failed` is workflow-disambiguated: it is paused for Door 1 and terminal only for a loop whose
stored policy is `onFail:"stop"`. `accepted` means only that the caller's declared criteria passed
in one iteration. It does not mean anyone looked at a frame. `storedEvidenceCeiling` is limited to
`structural | auto_judged`; no run schema accepts `vision_verified` or `device_verified`.

## Project generation and change conflicts

`ProjectLocatorV1` separates caller-visible path spelling from physical destination identity. The
resolver first canonicalizes the requested project/root paths with `path.resolve`, then stably
walks to the deepest existing ancestor without following a leaf implicitly, records that
ancestor's real path and decimal-string `{device,inode}`, and appends only a bounded safe
missing suffix. An existing project must be a directory and its stable `realpath` is the physical
project path. An absent project predicts that same path from the existing ancestor; after scaffold
creates it, its stable `realpath` must equal the prediction. Non-directory components, cycles,
outside-root results, replacement races, an ancestor identity change, or a different post-scaffold
physical path fail closed. A symlinked spelling is accepted only when the complete stable
resolution names the same physical root/project already stored; a retargeted alias is a conflict.
The private capability binds both requested and physical paths and revalidates them before its first
mutation and immediately after project creation.

Each locator observation still compares pre/post descriptor metadata including ctime to reject a
race, but ctime is not persisted as long-lived identity: authorized creation of the missing project
leaf and unrelated sibling changes legitimately update a parent directory's ctime. Persisted
ancestor device/inode, real paths, missing suffix, and final physical project path must continue to
agree. Later reads validate the stored anchor and walk its stored suffix; they do not replace it
with a newly deepest ancestor after authorized directories have been created. A public alias may
have a different requested spelling/anchor but matches V1 only when its freshly resolved
`physicalProjectDir` is identical. Both locator objects must pass their own stable resolution checks;
object equality is neither required nor sufficient for an alias.
The project resource key is always rederived from the validated physical path. Explicit run work
acquires the stored key then proves the current locator still resolves to it; coordinate-free/public
work derives a candidate key, acquires application→project, then repeats the locator observation.
Retargeting never causes an in-place switch to a second project lock.

Locator failures map by context and never fall through to an arbitrary failure shape. A malformed or
self-inconsistent locator already stored in a revision is `invalid-store`; drift of a previously
valid stored locator during an explicit run/resume is `external-state-conflict`; coordinate-free
target discovery or a public Fleet caller's unsafe/mismatched target is `target-conflict`; exhaustion
of a locator/path/work bound is `limit-exceeded`; and failure to publish state is
`state-write-failed`. A post-`attempt-started` locator change is an attributed
`attempt-conflicted` outcome when execution definitely stopped, or retained in-doubt when completion
is ambiguous. None of these paths invokes an unauthorized inner operation.

The target generation binds the mutable resources the workflow may overwrite or use to establish
target continuity:

1. the canonical user-brief file, represented as `absent` or stable bytes/hash; and
2. the physical directory generation plus selected Gradle input identity for the canonical fleet
   project, represented as `absent` or the current bounded observed pair.

The strict generation shape uses `absent | observed` for the brief and `absent | observed |
unobservable` for the project. An observed brief carries stable byte length and SHA-256. A brief
generation is measured with the bounded stable no-follow reader below; its payload is never adopted
as run intent. An observed project is produced by a stable no-follow project-directory descriptor
plus the existing `collectGradleInputIdentity` V1 implementation. Its
`directory.physicalPath` must equal both the collector's `projectDir` and
`target.projectLocator.physicalProjectDir`; decimal-string device/inode from that descriptor becomes
the durable directory generation after an existing project is admitted or an absent project is
created. A later delete/recreate conflicts whenever that stable physical-path/device/inode
generation changes, even if the new tree is byte-identical. POSIX can reuse an unlinked inode; V1
does not claim to distinguish a recreation that reproduces the complete stored directory generation
and selected-input bytes. The
input identity must preserve its exact receipt policy: allowlist/exclusions, stable reads,
canonical entry ordering, per-file/entry/total bounds, project real path, schema version, full
manifest digest, entry count, and total bytes. The literal policy identity
`pico-native-receipt-gradle-input-v1` must change if any equality-affecting collector rule changes.
Requested-path text is never substituted for the collector's physical root.
`unobservable` carries only a bounded reason and its digest; it may describe the aftermath of a
failed attempt but is never accepted as a precondition for another automatic attempt.

Build outputs, Gradle caches, arbitrary documentation, and other paths outside the accepted Gradle
input policy do not change this generation. The existing digest-bound receipt remains the stronger
identity for a successful native build, but it does not subsume the separately bound external-input
manifest or upgrade that structural identity into visual proof. This run-store manifest does not
change receipt-v1's schema, reader, evidence class, or ship authority.

### Attempt-bound external inputs

External host files are consumed but never owned by Fleet. Each attempt therefore binds them in its
own immutable external-input snapshot rather than silently adopting mutable paths or making them a
permanent target-base generation. A repaired missing asset may appear in a later attempt, but the
new bytes receive a new durable ref before any external call and the older attempt keeps its exact
history. A target-base child starts with no attempt input ref.

External-file collection is stable, bounded, and no-follow. It rejects symbolic-link components,
opens a regular one-link leaf with `O_NOFOLLOW`, charges count and descriptor size before hashing,
streams through a fixed buffer, compares pre/post `fstat`, and then requires the path still names
that descriptor. Byte-identical replacement between separate observations is equal; any replacement
during one observation is not. The IBL selector exactly preserves accepted Fleet behavior: a safe
real `<canonical-user-brief-dir>/ibl` directory selects the user base, its absence selects the
packaged corpus base, and a symlink, non-directory, unreadable, or changing user `ibl` entry fails
closed rather than silently falling back. Once selected, a missing user KTX never falls through to
corpus. For each safe KTX path, a valid file below the selected base wins; otherwise a valid existing
destination in the actual physical project is recorded as `project-generation`; otherwise the
choice is `unresolved`. The project choice remains governed by the Gradle/write-set identity.
Creating or removing the user `ibl` directory
changes the external manifest even when candidate KTX bytes happen to match.

Before `attempt-started`, the orchestrator performs the complete preparatory sequence under all
ordered execution locks. It observes and validates the target generation; collects the complete
external manifest while retaining the validated descriptors; copies every observed file from those
descriptors into the attempt-private view; independently rehashes the copies; closes every original
descriptor; publishes the immutable manifest CAS object; makes the sealed tree read-only; creates
the locally branded capability over that view; and re-observes the target
generation to require the same `expected` bytes immediately before publication. Only then may it link
the exact manifest ref in `attempt-started` and publish HEAD. No Fleet, project, generator, Gradle,
adb, ledger, receipt, install, launch, capture, or other external operation occurs during this
preparatory sequence.

Every consuming helper receives only that local capability and resolves semantic, occupancy,
model, sidecar, splat, pano, and IBL bytes from the sealed copies whose layout is derived from the
manifest, never from an original path or descriptor. The fixed staging parent is
`<run-store-root>/staging/fleet-inputs`; it is created and walked without following links and is not
selected from `TMPDIR`. The exact view path is
`<parent>/<application-owner-token>-<attemptId>`, created mode 0700 with create-only components;
pre-existence, an unsafe component, or a root mismatch fails closed. Files become read-only and
directories non-writable after validation.

Definite completion removes only that exact validated view with no-follow, token-checked traversal.
Recovery of dead matching application/project owners with neither a linked `attempt-started` nor a
visible public execution marker derives the same path from the store root and owner record, then
removes or quarantines only it; cleanup failure retains the owners and returns
`recovery-required`/`state-write-failed`. Recovery never enumerates an OS temporary directory. A
pre-attempt crash may leave an unreferenced CAS object, but no revision or external side effect, and
does not make the next call in-doubt. A view left after a linked attempt or visible public marker is
an orphan diagnostic, is never reused, and remains subject to the retained-owner rule.

Generation mismatch, unstable collection, materialization, or capability creation before `attempt-started` returns the
exact applicable `external-state-conflict`, `limit-exceeded`, or `state-write-failed` control result
with no new revision or core call. After `attempt-started` is HEAD-durable, the core first validates
the capability identity, every required current owner, and all sealed files. Definite sealed-view drift
before any mutating helper commits `attempt-conflicted` with
`externalSideEffectsByThisCall:"none"`; ambiguous execution obeys the ordinary retained in-doubt
rule. Original caller/corpus paths are not recollected after the view is sealed.

Before a mutating attempt, the orchestrator observes the current generation, requires it to equal
`projectGeneration.expected`, and commits it in an `attempt-started` revision. After a definitely
completed Fleet result, it observes the resulting generation and applies the attribution contract:

1. the canonical user-brief generation must be byte-identical to `before`, because V1 never writes
   that compatibility leaf;
2. the private result must prove that every sealed file consumed through the capability remained
   byte-identical to the attempt's immutable snapshot;
3. an unchanged project identity is attributable directly;
4. a changed project identity is attributable only when the private Fleet write set exactly covers
   the complete selected-input manifest diff and every recorded post-write identity still matches;
5. if the attempt produced a receipt, that after identity must also exactly equal the receipt's
   full receipt-v1 Gradle-input identity; and
6. an unobservable project, changed/tampered sealed input, extra/missing write, changed compatibility
   brief, receipt mismatch, or any other unattributed observation commits
   `attempt-conflicted` and never becomes `expected`.

Only an attributed ordinary outcome promotes the brief/project `expected` state to its
after-generation. The attempt-input ref remains immutable attempt history and is not promoted into
target lineage. A later resume
must freshly observe that exact generation before invoking Fleet. A durable `attempt-conflicted`
head is blocked and non-resumable even if someone later restores old bytes; it returns
`external-state-conflict` without a new state or external call. Because the runner is definitely
complete, its three execution locks release only after the blocked HEAD is durable. If completion is
not definite, the in-doubt rule below wins and the locks remain.

An interrupted attempt is never retried automatically in V1, even when the current generation still
equals its pre-attempt generation. The dead outer MCP process does not prove that a generator,
Gradle, adb, or other descendant process stopped, and excluded build outputs cannot prove
quiescence. Equality is reported only as change evidence; it is not permission for a second
execution. A mismatch additionally reports `external-state-conflict`. The run remains
`interrupted-in-doubt`, performs no new side effect, and names the exact retained
run/application/physical-project resource locks.
The store does not restore files or reinstall an older APK.

The server has no automatic or specified manual in-doubt unlock/reconciliation path in V1. The
in-doubt run and all three lock generations remain preserved and non-resumable. Administrative recovery
would require a separately designed process-tree supervisor and atomic three-lock protocol; this
design makes no claim that an operator can prove descendant quiescence from the stored owner record.
A caller may use a different target; the retained application and physical-project locks prevent a
second cooperating run from executing against either the installed app or this project.

If an existing project cannot be measured under the bounded source policy before an attempt, the
call returns `external-state-conflict` without starting one. An unobservable after-state from a
definitely completed attempt commits the blocked conflict transition. Neither path proceeds by
overwriting or adopting unbound bytes.

This is change detection, not Subproject 4 reuse. For an eligible paused, non-in-doubt resume, even
when generations match, V1 reruns the normal compiler/build/install/capture path and requires a
fresh receipt before any receipt-dependent conclusion.

### Run-owned brief payload and compatibility brief

The canonical user brief remains a compatibility target/collision sentinel, not run authority. V1
never creates, truncates, renames over, repairs, or updates `target.briefPath`. If it exists, the
strict 3 MiB stable reader accepts only canonical JSON `{id,brief,spec}` with no extra keys, expected
ID, exact byte-for-byte `brief === target.briefInput`, and a schema-valid spec. A symlink, hard-link
alias, non-regular file, replacement race, malformed/oversize payload, normalized-only equality, or
different spec is not adopted; occupied-target admission still requires `targetBase`. If absent,
it remains absent unless a legacy non-run workflow outside this design creates it.

Each non-null current AppSpec instead has one immutable CAS `BriefPayloadSnapshotV1` containing
strict `{kind,schemaVersion,id,brief,spec}`. Publication uses the same create-only link/fsync
protocol as every other snapshot. The additive Fleet execution interface accepts a private
validated brief-payload capability, exact derived path, physical-project capability, and matching
external-input capability. For a V1 run, the IBL asset base is the external manifest's exact
selection: `dirname(target.briefPath)` only when its safe `ibl/` directory was present during
observation, otherwise the validated packaged `corpusBriefsDir()`. It is never derived from the CAS
object directory. Model and world-file consumers likewise use only the manifest capability rather
than resolving caller strings again. For legacy fallback, Fleet retains the accepted directory of
the resolved user/corpus brief and its existing mutable path behavior. The public full-surface ID-only
`fleet_build` form remains available for legacy callers. Its run-store lookup accepts a leaf only
when `briefPayload` is non-null and the complete chain proves the same current-spec digest reached
`plan-completed/ready-to-build` before any attempt (and was not replaced afterward without another
successful plan); awaiting-authoring and plan-failed specs are not silently built. The wrapper
passes only the locally validated CAS/external/project capabilities to the shared core and does not
expose or forward `runId`. Run orchestration never asks Fleet to look up `target.briefPath`, and
Fleet remains unaware of `runId`.

The native receipt producer receives the immutable CAS path as `briefPath`, so its unchanged
authored-AppSpec identity binds the exact run input and remains historically/currently readable.
Fleet must prove the payload ID, original brief, AppSpec ref, package rewrite, path capability, and
external manifest/asset-base identity again before scaffold or generator work. The branded input
capability is usable only for the exact sealed-view resolution and bounded consumption described
above. A replan or explicit amendment publishes a new payload; the next attempt publishes
its matching external-input snapshot. Neither path mutates an earlier snapshot or the compatibility
brief.

This removes the non-portable check-then-rename leaf race entirely. V1 coordinates cooperating MCP
workflows and detects surviving selected-input changes before and between attempts. During an
authorized attempt the generator may overwrite declared generated project paths; POSIX does not
offer a portable atomic compare-and-swap for an existing regular-file leaf, so a non-cooperating
same-user editor concurrently writing the same declared path is outside V1's attribution boundary.
Any surviving change outside the exact Fleet write set still blocks continuation, and no arbitrary
post-attempt project observation is promoted.

## Locking and compare-and-swap

Every run mutation acquires locks in one fixed order: the run lock first, then its
application-resource lock, then its physical-project lock. No path acquires them in reverse order.
Public Fleet omits the run lock but keeps application→project order. The application resource key is SHA-256 over
the canonical app/package and fixed execution serial, deliberately excluding `projectsRoot`,
project-path spelling, and user-brief path. Different run IDs or public Fleet calls for one installed
application therefore cannot execute concurrently even when callers choose different project roots.
The project resource key is the canonical physical-project digest stored in the target; different
apps/IDs that resolve to one directory cannot mutate it concurrently. The separately stored
`ProjectLocatorV1` proves which physical project those owners are authorized to mutate; lock identity
never substitutes for locator validation, and the locator is rechecked after all locks are held.

There are two immutable V1 owner generations, never an in-place promotion:

1. **Coordination locks** protect target admission, revision-zero publication, planning, spec
   amendment, and other state-only transitions. Initial admission generates a run ID, acquires its
   global run-lock path before the run directory exists, then acquires the application and
   physical-project resource locks. All three coordination locks are released in
   project→application→run order only after the resulting HEAD is durable. They are never held
   into external execution.
2. **Execution locks** are newly acquired for one random `attemptId`. The orchestrator acquires the
   run, application-resource, and physical-project execution locks, validates the expected revision,
   target generation and project locator, then collects/publishes the fresh attempt-input manifest,
   completely seals its token-owned view, and creates the branded capability. It then publishes the
   matching `attempt-started` revision and HEAD. No Fleet,
   generator, Gradle, adb, launch, or capture call may begin before all three execution owners and that
   HEAD are durable.

The public full-surface `fleet_build` wrapper is not a run mutation and therefore takes no run
lock, but each brief takes matching application-resource and physical-project owner generations
before the shared core can mutate anything. Both owners use `mode:"execution"`, `runId:null`, one
random `attemptId`, and the derived application/project resource keys. A V1-backed route completely
collects/seals its view and creates `FleetExecutionInputsCapabilityV1`; a proven no-lineage route
creates only `LegacyFleetExecutionCapabilityV1` after the accepted stable brief preflight. Before the first
scaffold/generator/Gradle/adb/panel operation it
publishes the strict `EXECUTION_STARTED.json` marker defined below in the application owner and
directory-fsyncs it. The core accepts either capability only after that marker and both owner records
cross-validate. After the core and every wrapper-owned post-core operation return definitely, the
wrapper strictly validates the complete `FleetExecutionEnvelopeV1`, hashes its canonical bounded
form, and publishes `EXECUTION_COMPLETED.json` before either owner can be released. An in-doubt or
unvalidated result never publishes completion.

A dead valid public-Fleet acquisition prefix with no started target performed no external call; a
token-proven staging-only marker and any exact V1-backed sealed view may be cleaned before the
prefix is reaped in reverse order. A live owner, or a complete owner pair with a visible/uncertain
started target but no valid completed target, blocks both resources. A valid completed target is
the durable authority for definite `none|possible|confirmed` completion. Only then may cleanup
remove the exact sealed view, quarantine the project owner first, and quarantine the application
owner second. View cleanup failure retains the complete owner pair. A crash after project cleanup
therefore leaves the sole valid singleton state: the application owner plus its exact started and
completed markers; token-elected recovery finishes that cleanup. Every other post-start singleton,
missing-earlier-owner set, or mismatched pair is `invalid-store` and retained. An in-doubt result or
process death after only the started marker retains the complete pair. For a busy brief the public wrapper makes zero inner
generator/Gradle/adb calls and returns the current failure-shaped per-brief record plus additive
`coordinationStatus` and `coordinationContinuation`. Its exact failure-only status union contains
`run-busy`, `interrupted-in-doubt`,
`target-conflict`, `external-state-conflict`, `recovery-required`, `invalid-store`, `limit-exceeded`, and
`state-write-failed`. `coordinationContinuation` is non-null only for an otherwise build-eligible
open/paused V1 leaf and is exactly
`{tool:"pico_build_app"|"pico_loop",arguments:{runId:LowercaseUuidV4,expectedRevision:number}}`;
all other failures set it to null. A normal per-brief record omits both fields. Every such record has
`built/installed/concluded:false`, null artifact/receipt/verdict, and a bounded note naming the same
status. Other briefs remain serial. This closes the standard public Fleet bypass without claiming
coordination for raw low-level tools called directly outside Fleet/Doors.

A V1 acquisition may expose only one of the exact prefixes `{run}`, `{run,application}`, or
`{run,application,project}`; public Fleet may expose only `{application}` or
`{application,project}`. Acquisition never produces a suffix, and ordinary release/quarantine is
strictly reverse order: project, application, run. Before a matching revision target or public
started target exists, a dead valid prefix performed no external side effect. A contender that can
derive the same target coordinates acquires recovery elections only for that extant prefix in global
order, revalidates every matching owner and the absence of every later-scope owner from that same
run/attempt generation and target, removes the exact sealed view if any, then quarantines in reverse
order. An unrelated later replacement/busy generation is never counted as the missing peer and is
never touched. A crash after any quarantine therefore leaves another valid shorter prefix that the
same procedure can finish. A same-generation suffix, skipped middle scope, later matching owner
without its predecessor, unexpected quarantine, or target with an incomplete required set is
`invalid-store` and retained.

Each quarantine target is the unique sibling
`<lock-path>.released.<sha256(owner-token)>.<cleanup-token>`, where `cleanup-token` is a fresh
lowercase UUIDv4 owned by the releaser/election. The canonical lock directory is renamed there only
after its owner bytes/token are revalidated. A successful rename releases that scope; the sibling
is non-owning cleanup residue and cannot satisfy or block a later lock claim. Bounded root scans
recognize and disclose it, and may delete it only after a no-follow read proves the embedded owner
generation matches the name. A collision, malformed residue, second residue for one generation, or
content mismatch is the unexpected-quarantine case above and fails closed. Cleanup residue never
allows a suffix owner set or an otherwise unauthorized missing scope.

A raw revision target link that still has its staging hard-link alias is not the execution boundary:
it is `invalid-store`, invokes no external work, and retains the complete three-owner execution set
for diagnosis. The live execution boundary requires
a canonical `attempt-started` target, absent staging alias, and successful directory flush. For a
dead publisher, an alias-absent canonical target is conservatively classified as
publication-complete even when flush completion is unknowable. If that revision exists but HEAD still names its
parent, recovery advances HEAD to that exact tail under the three token-specific recovery elections
described below and retains all three owners as `interrupted-in-doubt`; it never tries to acquire the
occupied ordinary locks, reaps first, or leaves an unappendable tail. This deliberately sacrifices a no-work attempt at that narrow cut
rather than risk misclassifying work after an uncertain publication boundary. Once
`attempt-started` is HEAD-durable, the ordinary execution boundary below applies.

Each lock is an atomically published nonempty directory containing one canonical owner record:

```json
{
  "pid": 123,
  "processIdentity": "<OS process-start identity>",
  "token": "<random UUID>",
  "createdAt": "<ISO-8601>",
  "mode": "execution",
  "scope": "application",
  "runId": "<lowercase UUIDv4>",
  "attemptId": "<lowercase UUIDv4>",
  "resourceKey": "<64 lowercase hex>",
  "projectResourceKey": "<64 lowercase hex>",
  "physicalProjectDir": "<canonical physical absolute path>"
}
```

For a coordination owner, `mode` is `coordination` and `attemptId` is null. A run-scope owner has
`resourceKey/projectResourceKey/physicalProjectDir:null`. Application- and project-scope owners have
both keys and the physical path, with `scope:"application" | "project"` selecting the lock path. All
three V1 owners bind the same run and, for execution, the same attempt ID. The public-Fleet
application/project pair is exactly the nullable-run form specified above; no other null, scope, or
mode combination validates. Each record is strict canonical JSON plus one newline; unknown fields,
wrong key/path derivations, symbolic links, and cross-owner disagreement are invalid.
The sole missing-peer exception is an application owner with a valid completed marker after the
matching project owner has already been token-quarantined and optionally removed; the marker's
project token/key/path are the durable cross-owner witness for finishing only that reverse-order
cleanup. A later replacement at the canonical project-lock path is a different generation and is
never read as the missing peer or touched by that cleanup.
Its exact filename is `<token>.owner.json`, preserving the trust-ledger owner-generation protocol.
A project owner directory permits only that one record. A public-Fleet application owner directory
also permits the exact started/completed marker and staging names below; any other entry is invalid.

The public execution marker is also a strict canonical envelope:

```typescript
type PublicFleetExecutionMarkerV1 = {
  kind: "pico.public-fleet-execution-started";
  schemaVersion: 1;
  createdAt: CanonicalUtcTimestamp;
  applicationOwnerToken: LowercaseUuidV4;
  projectOwnerToken: LowercaseUuidV4;
  attemptId: LowercaseUuidV4;
  resourceKey: Sha256;
  projectResourceKey: Sha256;
  physicalProjectDir: string;
  briefPayloadSha256: Sha256;
  inputMode: "sealed" | "legacy-mutable";
  externalInputSha256: Sha256 | null;
};

type PublicFleetCompletionMarkerV1 = {
  kind: "pico.public-fleet-execution-completed";
  schemaVersion: 1;
  completedAt: CanonicalUtcTimestamp;
  applicationOwnerToken: LowercaseUuidV4;
  projectOwnerToken: LowercaseUuidV4;
  attemptId: LowercaseUuidV4;
  resourceKey: Sha256;
  projectResourceKey: Sha256;
  physicalProjectDir: string;
  briefPayloadSha256: Sha256;
  inputMode: "sealed" | "legacy-mutable";
  externalInputSha256: Sha256 | null;
  executionDisposition: "definitely-completed";
  phase: "complete" | ExternalPhaseV1;
  externalMutationDisposition: "none" | "possible" | "confirmed";
  resultSha256: Sha256;
};
```

`inputMode:"sealed"` requires the V1-backed capability's non-null external digest;
`legacy-mutable` requires null. Every other field must equal the two owners and local capability.
The target name is exactly `EXECUTION_STARTED.json`; the only recognized staging name is
`.EXECUTION_STARTED.<application-owner-token>.<attemptId>.staging` in the same application owner
directory. It is created mode 0600 with `O_EXCL|O_NOFOLLOW`, receives canonical bytes plus one
newline, then uses descriptor flush, create-only target link, staging unlink, and application-lock
directory flush. The core may begin only after target creation,
alias removal, and the directory flush all return successfully. With dead owners, a token-matching
staging-only file and no target is proven pre-boundary and may be cleaned with any sealed view. In
the absence of a valid completed target, any valid started target—even if its staging alias remains
or flush completion is unknown—is `interrupted-in-doubt` and retains both owners. A malformed,
noncanonical, wrong-token, unknown, or
unsafe target marker is `invalid-store` and also retains both; it is never deleted or treated as
absence. The initiating publisher that directly observes link/unlink/flush failure returns
`state-write-failed` with no core call and retains the owners whenever the target became visible;
a later observer conservatively sees the marker state above. Live partial publication observed by
another call is `run-busy`. These classifications happen before core or mutable
legacy asset resolution; the read-only stable brief preflight may already have completed.

The completion marker repeats every identity/input field from the validated started marker and both
owners. `resultSha256` covers the canonical strict `FleetExecutionEnvelopeV1` whose disposition is
`definitely-completed`; its phase and external-mutation disposition equal the marker. Its target is
exactly `EXECUTION_COMPLETED.json`, and its only staging name is
`.EXECUTION_COMPLETED.<application-owner-token>.<attemptId>.staging`. Publication uses the same mode
0600, `O_EXCL|O_NOFOLLOW`, canonical-bytes-plus-newline, descriptor-flush, create-only-link,
staging-unlink, and application-owner-directory-flush protocol. The target may be created only after
the last operation that can make the public call in-doubt. A visible valid completed target is
durable completion authority even if its token-matching staging alias remains; recovery may remove
that alias and finish reverse-order owner cleanup, but it never reconstructs or returns the lost
public result from the digest alone. A staging-only completion file is not completion authority:
with the started target it remains `interrupted-in-doubt`. A malformed, noncanonical, unsafe, or
mismatched completed target is `invalid-store` and retains every extant owner. If completion
publication fails before its target is visible, the initiating call returns `state-write-failed`
and retains both owners; if a valid target is visible, it finishes or delegates the same
token-checked cleanup protocol rather than reverting to in-doubt classification.

Acquisition follows the trust ledger's proven owner-generation protocol: live owners are never
reaped by elapsed time, PID reuse is distinguished by process-start identity, malformed or
symbolic-link ownership fails closed, dead-owner cleanup uses a separate election, and release
renames/removes only the generation whose token still matches.

Failure to obtain the current process-start identity returns `state-write-failed` before publishing
a lock, run revision, or invoking planner/Fleet work. PID alone is never written as a weaker owner.

A dead coordination prefix whose matching state transition is HEAD-durable, or an execution prefix
whose matching definite outcome is HEAD-durable, may be reaped by the token/election protocol in
reverse order. The durable transition authorizes a missing later-scope owner only when every extant
earlier owner is the exact token/mode/run/attempt generation for that transition; this makes
`{run,application}` and then `{run}` valid cleanup-crash states after project and application
quarantine. A dead execution whose committed head is still `attempt-started` or
`attempt-in-doubt` requires the complete three-owner set and is not reaped: the retained locks are
the durable in-doubt block. If one exact valid outcome revision is already linked beyond a lagging
head, recovery first requires the complete owner set, may validate and advance that head under the
token-specific recovery elections, and only after that durable advance may quarantine in reverse
order. A missing earlier owner, non-prefix set, corrupt or mismatched referenced state, or missing
later owner without one of the explicit pre-boundary/definite-outcome authorities fails closed and
never authorizes reaping.

A recovery election is not an occupied run/application/project resource lock. It is a separate
create-only directory derived from that exact lock path and owner token. Recovery acquires elections
for the exact extant valid prefix in run→application→project order, revalidates that each extant
matching owner is dead and still byte-identical and that every absent same-generation later scope is
authorized by the state classification above, then quarantines project→application→run. A
different generation that has since occupied a released later scope is left intact. Recovery may
only publish the
already-linked tail's HEAD and invokes no planner/Fleet/project/device work. For an
`attempt-started` tail it deliberately leaves the complete three-owner set in place; for a definite
outcome tail it may begin reverse quarantine only after HEAD is durable. A live, changed, malformed,
differently tokened, non-prefix, or unauthorized missing owner makes recovery fail closed. Each
quarantine and election release is token-checked and independently durable before the next scope;
a crash is resumed from the resulting shorter prefix.

Public Fleet has no run election and uses application→project order. Before the started target it
may clean `{application,project}` then `{application}` in reverse; after started it requires the
complete pair unless a valid completed marker authorizes the application-only cleanup state. It may
only classify/clean its strict marker/view state and never publishes a run HEAD.

The complete ordered lock acquisition has one shared 15-second budget using the same injected
monotonic elapsed-time source; it is not renewed per lock. A still-live ordinary owner returns `run-busy`; a head
already committed as `attempt-in-doubt` returns `interrupted-in-doubt` whether its retained owner is
live or dead. A dead `attempt-started` execution also returns `interrupted-in-doubt`. No external
work has started for the contender.

The same boundary applies when the outer handler remains alive but an inner runner times out,
disconnects, or cannot prove its scoped process ended. Such a result cannot publish an ordinary
paused/terminal outcome and release the project for another execution. It publishes the matching
`attempt-in-doubt` revision and HEAD while all three locks remain held, then returns
`interrupted-in-doubt` without running the ordinary release path. `finally` cleanup must distinguish
releasable coordination/completed-attempt owners from retained in-doubt execution owners.

Only a definite completed runner outcome may publish a matching `attempt-paused`,
`attempt-conflicted`, `iteration-completed`, or `run-terminal` revision and HEAD. All three execution
locks may be released in project→application→run order only after that outcome HEAD is durable and
still names the same `attemptId`.
V1 does not infer descendant-process quiescence from unchanged source files.

While holding all three locks, resume re-reads and validates the complete state before comparing
`expectedRevision`. A mismatch returns:

```json
{
  "status": "revision-conflict",
  "runId": "11111111-1111-4111-8111-111111111111",
  "revision": 5,
  "revisionId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expectedRevision": 3,
  "actualRevision": 5,
  "actualRevisionId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "runStateByThisCall": "unchanged",
  "externalSideEffectsByThisCall": "none",
  "priorAttemptExternalSideEffects": null,
  "activeAttemptExternalSideEffects": null,
  "inDoubtAttemptCompletion": null,
  "runRevisionCommitted": null,
  "runRevisionPublication": null,
  "expectedGeneration": null,
  "observedGeneration": null,
  "historicalResult": null,
  "issues": [],
  "detail": "Expected revision 3, but the authoritative HEAD is revision 5.",
  "fix": "Re-read the reported revision before deciding whether to continue."
}
```

Two callers starting at revision `N` can therefore produce at most one mutating attempt. A caller
that times out behind the live writer receives `run-busy`; one that obtains the lock afterward
receives `revision-conflict`. Neither result performs project, build, install, launch, or capture
work.

Capacity for every revision the operation may require is checked before the first external side
effect. Approaching the revision limit returns `revision-limit`; the implementation must not begin
an attempt that could commit `attempt-started` but has no capacity for its outcome.

## Publication, reading, and crash recovery

Snapshot and revision publication uses a unique same-directory staging file, descriptor flush,
create-only atomic link, staging unlink, and directory flush. An existing byte-identical snapshot
may be reused. An existing revision target is never overwritten or treated as a new successful
append. A crash may leave an unreferenced immutable snapshot; V1 preserves it and does not run an
automatic garbage collector.
For revisions, “publication-complete target” below means the canonical target exists and its exact
staging hard-link alias is absent; the live publisher additionally requires the directory flush to
return before continuing. A crash after alias removal is recoverable from the observable target on
the still-running filesystem, while an injected directory-flush failure returns
`state-write-failed`; this is not described as a power-loss proof.

After a revision and its directory are durable, `HEAD.json` is written to a unique staging file and
atomically renamed over the previous head, followed by a run-directory flush. The old head must
equal the new revision's parent while the lock is held. HEAD has a strict canonical envelope
containing only:

```typescript
type RunHeadV1 = {
  kind: "pico.workflow-run-head";
  schemaVersion: 1;
  runId: LowercaseUuidV4;
  revision: number;
  revisionId: Sha256;
  updatedAt: CanonicalUtcTimestamp;
};
```

The reader:

1. validates every existing root/run/revisions path component and bounds directory entries;
2. observes the run/application/project lock generations and returns a running/`run-busy` projection instead of
   diagnosing a live writer's half-published staging state, except that a stable
   `attempt-in-doubt` HEAD projects that exact status;
3. reads HEAD without following a symbolic link;
4. validates revisions `0..HEAD.revision`, all parent links, all identities, and all core snapshots;
5. inspects later canonical revision filenames and recognized staging leftovers; and
6. re-reads HEAD and lock identity so a concurrent change cannot produce a mixed projection.

Read-only access retries one changed-head snapshot, then returns `run-busy`. It never acquires a
long-lived execution lock.

Crash states are exact:

- a staging object in CAS or alongside an otherwise valid committed run: ignored as unpublished
  but disclosed in bounded diagnostics;
- a dead valid acquisition prefix with no matching target, or a shorter valid release prefix after
  its coordination/definite-outcome HEAD, is `recovery-required` for token-checked reverse cleanup;
  a non-prefix owner set or unauthorized missing earlier scope is `invalid-store` and retained;
- an allocated UUID run directory with no revision and no live owner: `invalid-store`, never a
  valid empty run;
- a linked revision target that still has its staging hard-link alias after its owner died: `invalid-store`;
  V1 preserves both names and all matching execution owners for diagnosis rather than guessing that unlink is safe;
- one publication-complete valid contiguous revision immediately beyond HEAD: `recovery-required`;
- when that one tail is `attempt-started`, locked recovery advances HEAD to it and returns
  `interrupted-in-doubt` while retaining all three matching owners, even though the crash may have
  preceded the first external call;
- revision zero with no HEAD during first publication: `recovery-required`;
- HEAD update durable before the response: committed; retrying the old expectation conflicts;
- `attempt-started` or `attempt-in-doubt` head without a definitely completed matching outcome:
  `interrupted-in-doubt`, with all execution locks retained;
- HEAD ahead of files, corrupt/missing interior state, a gap, parent mismatch, noncanonical file,
  unknown schema, or more than one unexplained tail: `invalid-store`.

Only a mutating resume holding the ordinary ordered locks, or the exact three token-specific recovery
elections when those locks are retained, may recover a lagging head. It validates the one exact
contiguous tail, atomically advances HEAD, and then re-evaluates the caller's expected revision. It never
moves HEAD backward, fabricates an outcome for a running attempt, or consumes a later revision
past corrupt state.

If a definite external outcome is known but outcome revision, HEAD publication, or subsequent
response construction fails, the public call returns `state-write-failed` and reports the stable
post-failure observation exactly. A proven unlinked outcome with the prior HEAD still authoritative
uses `runRevisionCommitted:false`, `runRevisionPublication:"not-linked"`, and
`runStateByThisCall:"unchanged"`. One linked outcome beyond the prior HEAD uses `false`,
`"linked-head-pending"`, and `"publication-in-doubt"`. An observation that cannot distinguish
those states uses `null`, `"unknown"`, and `"publication-in-doubt"`. If the outcome HEAD and its
required directory flush were already proven complete before a later response-path failure, it
uses `true`, `"head-authoritative"`, and `"durably-advanced"`; a retry then replays that committed
result. `externalSideEffectsByThisCall` remains the definite attempt accumulator's exact
`none|possible|confirmed` disposition rather than being inferred from the publication failure. The
call cannot return an accepted or success-shaped workflow status on the error path. It may disclose
a separately validated orphan receipt as structural diagnostic evidence, but that receipt does not
repair the run chain. Execution locks remain retained unless and until the matching outcome HEAD is
durable and token-checked release or recovery authorizes their removal.

## Path and corruption boundary

Before creating or opening state, the store walks every existing path component with `lstat`,
rejects symbolic links and non-directories, and creates missing direct children one component at a
time. Leaf readers use no-follow descriptors, require regular files with one link, enforce bounded
reads, and compare descriptor metadata before and after reading. Publishers revalidate parent
identity around publication.

Node does not expose an `openat`-style descriptor-relative tree API. A privileged same-user actor
that races and consistently replaces the entire validated root remains outside V1. Local POSIX
filesystems are the measured target; network filesystems and native Windows durability are not
claimed.

Corrupt state is preserved for diagnosis. The reader returns bounded issues and never deletes,
rewrites, skips, or selects around an invalid committed revision. Cleanup is limited to unique
staging/quarantine paths created by the current process and token-matched dead-owner generations.

## Receipt and evidence revalidation

Immutable history and current effective provenance remain separate:

- publication accepts a receipt ref only through the historical receipt validator;
- every run read revalidates the exact historical receipt core and capture bytes;
- a reader with no injected historical receipt validator treats every claimed receipt ref as
  unverifiable rather than retaining it as effective authority;
- a missing or tampered receipt remains visible under `claimedReceiptReferences`, is removed from
  effective receipt refs, and adds one bounded per-reference
  `receiptProvenance:BoundedDiagnosticV1` result with an exact reason code/detail/digest;
- a terminal transition whose own conclusion depends on an unverifiable receipt receives
  `effectiveLifecycle.status:"provenance-broken"` without rewriting its stored lifecycle or the
  revision chain; an unrelated older broken receipt does not invalidate a newer independently
  intact conclusion, but if that older receipt supplies fields in the reported iteration history
  the replay uses authority-stripped history rather than exposing those fields at top level;
- intact goal/spec/compiler/iteration history remains readable when only receipt provenance breaks;
- historical validity describes what the workflow observed then; current build reuse or shipping
  still requires the current-project receipt reader and rejects source/APK drift; and
- later ledger LOOK evidence is not joined into the V1 run projection. A caller may query it through
  the existing trust-ledger/ship boundary, but V1 stores no reference to it and never rewrites a
  revision, changes either run evidence ceiling, or upgrades a run status.

`auto_judged` has one named durable authority. The run may persist this strict reference:

```typescript
type AutoJudgeEventRefV1 = {
  kind: "pico.auto-judge-ledger-event";
  schemaVersion: 1;
  app: string;
  seq: number;
  eventDigest: Sha256;
  receiptId: Sha256;
  captureSha256: Sha256;
};
```

The run layer cannot construct this from a fleet boolean or caller-shaped object. At publication an
injected ledger resolver must return the exact effective entry at `app`/`seq`; the row must be
unretracted `auto_judged`, have intact ledger-owned capture bytes, pass the producer-owned
`visual_judge` provenance check, and match the separately validated receipt ref's app and capture
digest. `receiptId` comes from that validated receipt ref; the current ledger row need not contain a
receipt field because the run revision binds both immutable authorities together.

`storedEvidenceCeiling:"auto_judged"` requires a non-null `autoJudgeEvidence` accepted through this
path and a conclusion that names its matching receipt/capture. Preserving accepted loop behavior,
the exact same Fleet iteration's validated eye event may set this ceiling even when acceptance had
no visual criterion; that event is auxiliary evidence for the iteration, not a dependency of its
nonvisual acceptance. A rejected/missing ledger write stores `autoJudgeEvidence:null` and a
structural ceiling. An event from a different iteration, later row, receipt, or capture is never
copied into the run.

`eventDigest` is SHA-256 over canonical JSON of the effective row's authoritative subset with
optional fields expanded to null:
`{seq,evidenceType,claim,artifactPath,attestation,cClass,capture,runReceipt,evidenceProducer,
autoJudge,reproHash}`. Derived reader annotations such as `producerProvenance`,
`runReceiptProvenance`, and `claimedEvidenceType` are excluded. The resolver returns a private
validated capability; a plain object with the same fields is rejected.

On every run read, an injected auto-judge validator must resolve the same app/sequence again and
prove that the row remains effective, unretracted, producer-valid, capture-intact, and identical by
event digest, receipt ID, and capture digest. With no validator, or when the row is missing, broken,
changed, or retracted, the stored reference remains visible but
`effectiveEvidenceCeiling` becomes `structural` and the projection adds
an `autoJudgeProvenance` issue. The reader validates every unique event referenced by a revision
whose outcome is projected into `iterationsLog`, not only the terminal revision's current event. A
broken older event does not invalidate an independently supported later acceptance, but any
historical row that claimed `recordedEvidence:true` forces the authority-stripped projection so the
unsupported visual row remains only inside `historicalResult`. A valid later ledger row never upgrades an
older revision that stored `structural`; only the exact stored event may sustain a stored
`auto_judged` ceiling.

If only an `auto-judged-needs-look` conclusion loses this authority while its receipt remains valid,
its effective public status is `built-needs-look`. If an `accepted` loop actually stored a non-null
auto-judge event and acceptance contained one or more visual criteria whose matching outcomes all
say `recordedEvidence:true`, loss of that exact authority makes its effective lifecycle
`provenance-broken`. Every such visual outcome is tied to the same one Fleet event/receipt/capture;
mixed event identities or recorded flags are invalid at publication. If acceptance had no visual
criterion, loss of its auxiliary same-iteration event preserves effective status `accepted`, lowers
the ceiling to structural, and uses the authority-stripped projection so the historical machine
verdict/auto ceiling survive only in `historicalResult`. An accepted visual machine PASS whose ledger write was
rejected retains the current accepted result with `storedEvidenceCeiling:"structural"`,
`autoJudgeEvidence:null`, and `recordedEvidence:false`; it never claimed durable auto-judged proof,
so no missing event is fabricated or revalidated. Receipt failure independently makes any
receipt-dependent conclusion `provenance-broken`.

Dependency is deterministic, not caller-authored: Door 1 `built-needs-look` and
`auto-judged-needs-look`, plus loop `built-needs-look` and every loop `accepted` result, depend on
the exact current receipt. A loop `accepted` result depends on an auto-judge event iff the revision
stores that exact non-null event and its acceptance snapshot contains at least one visual criterion;
every corresponding accepted visual outcome must then say `recordedEvidence:true` and match it.
Failure, pause, and budget-policy conclusions do not depend on a receipt merely because their
historical result also reports the last capture. The reader still strips any broken effective
receipt fields from those projections and reports the provenance issue.

The read projection exposes `storedEvidenceCeiling`, `effectiveEvidenceCeiling`, stored and
effective lifecycle, claimed/effective receipt refs, and both provenance issue lists separately.
Existing result/status compatibility refers to the immutable stored result; `pico_next`, resume
eligibility, current reuse, and ship guidance use the effective projection.

`EffectiveLifecycleV1` is the stored `LifecycleV1` union plus
`{status:"provenance-broken",storedStatus:TerminalPublicStatusV1}`. It is projection-only and is
never written into an immutable revision. `EffectivePublicStatusV1` is `PublicWorkflowStatusV1 |
"provenance-broken"`. The strict projection/replay metadata is:

```typescript
type EffectiveLifecycleV1 = LifecycleV1 | {
  status: "provenance-broken";
  storedStatus: TerminalPublicStatusV1;
};

type EffectivePublicStatusV1 = PublicWorkflowStatusV1 | "provenance-broken";

type RunProjectionMetadataV1 = {
  projection: "exact" | "authority-stripped" | "auto-downgraded" |
    "provenance-broken";
  runId: LowercaseUuidV4;
  revision: number;
  revisionId: Sha256;
  replayed: boolean;
  storedLifecycle: LifecycleV1;
  effectiveLifecycle: EffectiveLifecycleV1;
  storedStatus: PublicWorkflowStatusV1 | null;
  effectiveStatus: EffectivePublicStatusV1 | null;
  storedEvidenceCeiling: "structural" | "auto_judged";
  effectiveEvidenceCeiling: "structural" | "auto_judged";
  claimedReceiptReferences: NativeReceiptRefV1[];
  effectiveReceiptReferences: NativeReceiptRefV1[];
  receiptProvenance: BoundedDiagnosticV1[];
  autoJudgeProvenance: null | {
    status: "valid" | "unverifiable";
    issues: BoundedDiagnosticV1[];
    issueCount: number;
    issuesTruncated: boolean;
  };
  historicalResult: BuildAppPublicResultV1 | PicoLoopPublicResultV1 | null;
  runStateByThisCall: "unchanged";
  externalSideEffectsByThisCall: "none";
};

type ProjectionMetaV1<P extends RunProjectionMetadataV1["projection"]> =
  Omit<RunProjectionMetadataV1, "projection" | "replayed"> &
  { projection: P; replayed: true };

type HistoricalProjectionMetaV1<P extends Exclude<
  RunProjectionMetadataV1["projection"], "exact">> =
  Omit<ProjectionMetaV1<P>, "historicalResult"> & {
    historicalResult: BuildAppPublicResultV1 | PicoLoopPublicResultV1;
  };

type BuildFailureProjectionV1 = {
  kind: "build";
  status: "fail";
  detail: string;
};

type SanitizedNonVisualOutcomeV1 = {
  inputIndex: number;
  criterionDigest: Sha256;
  kind: "structural" | "logcat" | "perf";
  status: "pass" | "fail" | "unmeasurable";
  detail: string | null;
  failureClass: string | null;
};

type SanitizedIterationLogRowV1 = {
  iteration: number;
  outcomes: Array<SanitizedNonVisualOutcomeV1 | BuildFailureProjectionV1>;
  omittedVisualOutcomeCount: number;
  ledger: string;
};

type AuthorityStrippedReplayV1 = HistoricalProjectionMetaV1<"authority-stripped"> & {
  status: PublicWorkflowStatusV1;
  summary: {
    workflow: "pico-build-app" | "pico-loop";
    briefId: string | null;
    projectDir: string | null;
    built: boolean | null;
    installed: boolean | null;
    iterations: number | null;
    scaffoldStarted: boolean | null;
    iterationsLog: SanitizedIterationLogRowV1[];
  };
  detail: string;
  fix: string;
};

type AutoDowngradedReplayV1 = HistoricalProjectionMetaV1<"auto-downgraded"> & {
  status: "built-needs-look";
  briefId: string;
  built: boolean;
  installed: boolean;
  autoJudgedRecorded: false;
  receiptId: Sha256;
  receiptPath: string;
  capture: string;
  projectDir: string;
  honesty: string;
  fix: string;
};

type ProvenanceBrokenReplayV1 = HistoricalProjectionMetaV1<"provenance-broken"> & {
  status: "provenance-broken";
  detail: string;
  fix: string;
};

type ReplayResultV1 =
  | (ProjectionMetaV1<"exact"> &
      { historicalResult: null } &
      (BuildAppPublicResultV1 | PicoLoopPublicResultV1))
  | AuthorityStrippedReplayV1
  | AutoDowngradedReplayV1
  | ProvenanceBrokenReplayV1;
```

`projection:"exact"` requires equal statuses/ceilings, empty issue arrays, and
`historicalResult:null`; its exact stored workflow result is spread at top level.
`autoJudgeProvenance` is null only when the complete projected history claims no auto event. Its
`valid` arm has zero issues/count and `issuesTruncated:false`; `unverifiable` has a positive count,
retains the first 64 event-specific bounded diagnostics in revision/evaluation order, and reports
truncation exactly. The run-level 64-unique-event work ceiling is enforced before a partial
provenance result is selected.
`authority-stripped` keeps an independent conclusion's status but projects only the exact `summary`
above. Its iteration rows omit nested `capture`, `receiptId`, and `receiptPath`, and the outer shape
omits verdict, visual-ledger, remaining-look, and artifact fields; it requires the exact old value in
`historicalResult`. They also omit every visual outcome and disclose its count; retained nonvisual
rows remove `machineVerdict`, `recordedEvidence`, and `machineChecks`. A blocked iteration
reconstructs exactly one `BuildFailureProjectionV1` from its stored bounded failure. The synthetic
build row never pretends to have an acceptance `inputIndex` or `criterionDigest`.
`auto-downgraded` is limited to Door 1's former
`auto-judged-needs-look`, requires primary/effective `built-needs-look`, a valid effective receipt,
forced `autoJudgedRecorded:false`, and historical result. It omits the old free-form notes because
their origin is not structured enough to prove they contain no invalidated visual verdict. A loop
`accepted` result that loses its
recorded visual authority is provenance-broken. `provenance-broken` permits only status, bounded detail/fix, and this metadata at top level;
it requires historical result and forbids old success fields. This is the only source of effective
status for replay and `pico_next`.

Open `ready-to-plan`/`ready-to-build`, running, and blocked read projections have null stored/public
status when no public-result snapshot exists; their lifecycle remains the routing authority. A
replayable public result always has non-null stored/effective status and the cross-field rules above.

Auto-judge resolution is bounded and targeted. The injected validator stably reads at most 8 MiB
from the exact app ledger, accepts at most 4,096 events, bounds each parsed event's canonical value
to 64 KiB and depth 32, and resolves only the requested sequence. A per-ledger limit/corruption
failure makes that event unverifiable; it does not make core run history valid or invalid. Aggregate
projection budgets below may instead stop `pico_next` with `limit-exceeded` before selecting a
partial candidate.

Receipt v1 and its summary remain strict and unchanged. A stored run does not make a structural
capture visually correct.

## Door interfaces and compatibility

No new Door is added. The Doors surface remains exactly 18 tools.

All current initial invocation forms, status strings, result fields, text JSON responses,
`briefId` mapping, package identity, project location, receipt fields, capture field, notes, fixes,
and honesty text remain compatible. Every accepted workflow result adds:

```json
{
  "runId": "<lowercase UUIDv4>",
  "revision": 4,
  "revisionId": "<64 lowercase hex>",
  "runStateByThisCall": "durably-advanced",
  "externalSideEffectsByThisCall": "confirmed"
}
```

The two dispositions follow the exact transport-only predicate below. A scaffold/planning
checkpoint normally says `durably-advanced/none`; an unchanged replay says `unchanged/none`; and a
definite attempt result reflects the attempt accumulator's exact `none|possible|confirmed` external
disposition.

Compatibility here means existing initial syntax and ordinary result shapes remain accepted. The
intentional behavioral exception is an occupied pre-V1 or changed target: it now returns
`target-conflict` instead of silently adopting/reusing mutable bytes. A public `fleet_build` ID with
V1 lineage has additional coordination restrictions: it executes from V1 authority only for one
terminal leaf; an open/paused leaf returns `target-conflict` with its Door continuation coordinate;
a custom `projectsRoot` that resolves to a genuinely different physical project also returns
`target-conflict`, while an alias of the stored physical project remains accepted. With no V1
lineage on either the requested application or physical-project resource, the existing custom-root mapping and mutable
user/corpus/asset lookup and V1-exempt size/model behavior remain accepted, now serialized by the
application and physical-project locks. That legacy fallback requires a complete within-bound run
store scan: a V1 lineage for another app that owns the same physical project returns
`target-conflict`, an unknown/corrupt candidate returns `invalid-store`, and an aggregate overflow
returns `limit-exceeded`, rather than guessing that no V1 lineage exists. These fail-closed
coordination conditions are intentional exceptions; they do not impose V1 asset restrictions on a
clean no-lineage legacy call.
Resume/amendment/target-base fields are additive.

Run coordinates are transport metadata and are not placed inside the public-result snapshot,
avoiding a result/revision identity cycle. A matching resume at a terminal head validates the
complete chain, the `public-result` snapshot, and current effective provenance, then selects exactly
one replay shape:

1. **All reported authority unchanged:** the exact stored public result remains at top level, plus coordinates,
   `replayed:true`, equal stored/effective status and ceilings, and `historicalResult:null`.
2. **Only auxiliary receipt fields break for a conclusion that does not depend on them:** the
   primary status stays the same, broken receipt/capture fields are absent, and the exact old result
   appears only as `historicalResult`.
3. **Door 1 auto-judge authority lost but the bound receipt remains valid:** the primary status is
   `built-needs-look`; only `AutoDowngradedReplayV1`'s fields and effective receipt/capture remain at
   top level; `autoJudgedRecorded:false`; the old result appears only as `historicalResult`.
4. **Receipt-dependent or recorded-auto-dependent authority broken:** the primary status is
   `provenance-broken`; no old `accepted`, verdict, `autoJudgedRecorded`, receipt, or capture field is
   spread into the top level; the old result appears only as `historicalResult`, with claimed and
   effective refs and bounded provenance issues explicitly separated.

The latter two are strict effective projections, not additive annotations on a success-shaped
object. An additive-unaware caller therefore cannot mistake historical `accepted` or
`autoJudgedRecorded:true` for current authority.

```json
{
  "status": "provenance-broken",
  "detail": "The stored conclusion's exact receipt is no longer verifiable.",
  "fix": "Inspect the provenance issue; rebuild for a fresh receipt before relying on this result.",
  "runId": "11111111-1111-4111-8111-111111111111",
  "revision": 4,
  "revisionId": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "replayed": true,
  "storedEvidenceCeiling": "structural",
  "effectiveEvidenceCeiling": "structural",
  "storedLifecycle": { "status": "terminal", "publicStatus": "built-needs-look" },
  "effectiveLifecycle": { "status": "provenance-broken", "storedStatus": "built-needs-look" },
  "storedStatus": "built-needs-look",
  "effectiveStatus": "provenance-broken",
  "projection": "provenance-broken",
  "historicalResult": {
    "status": "built-needs-look",
    "briefId": "door123",
    "built": true,
    "installed": true,
    "verdict": null,
    "autoJudgedRecorded": false,
    "receiptId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "receiptPath": "/tmp/receipt.json",
    "capture": "/tmp/capture.png",
    "notes": [],
    "projectDir": "/tmp/fleet-door123-native",
    "honesty": "Structural receipt only; LOOK remains required."
  },
  "claimedReceiptReferences": [{
    "kind": "pico.native-run-receipt",
    "schemaVersion": 1,
    "app": "com.fleet.door123",
    "receiptId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "captureSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  }],
  "effectiveReceiptReferences": [],
  "receiptProvenance": [{
    "code": "receipt-missing",
    "detail": "The exact receipt file could not be read.",
    "detailSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }],
  "autoJudgeProvenance": null,
  "runStateByThisCall": "unchanged",
  "externalSideEffectsByThisCall": "none"
}
```

`historicalResult` is the complete strict stored public-result value whenever effective projection
suppresses or changes any authority-bearing stored field; it is absent only for an exact unchanged
projection, where it is literal null. Receipt and auto-judge issue arrays contain bounded strict diagnostics. Replay performs
no revision, planner/inner MCP call, brief-payload publication, project
mutation, build, install, launch, or capture. A retry carrying the old pre-commit expectation still
returns `revision-conflict`; the caller then retries the reported current coordinate to receive the
replay. A corrupt or missing result snapshot is `invalid-store`, never a partial reconstruction.

The unchanged-authority replay rule applies to `awaiting-authoring` when no `draftSpec` is supplied,
allowing a lost scaffold response to be recovered. A supplied valid `draftSpec` advances it; a
paused retry is an execution request and does not replay the prior pause result. `pico_next` never
emits `provenance-broken`, `external-state-conflict`, or in-doubt state as a successful continuation;
only provenance-broken with an independently intact generation may offer the explicit fresh-child
rebuild action defined below.

Schema-invalid calls that fail before intent normalization do not create a run. The additive public
MCP schemas first widen only presence, not value grammar:

```typescript
type AppSpecInput = unknown;

type AcceptanceInput = Array<{
  kind: "structural" | "visual" | "logcat" | "perf";
  entitiesPresent?: string[];
  minEntities?: number;
  componentsPresent?: string[];
  pattern?: string;
  tag?: string;
  timeoutSec?: number;
  minAppFpsP5?: number;
  durationSec?: number;
}>;

type BudgetInput = {
  iterations?: number;
  timeMin?: number;
  toolCalls?: number;
};

type BuildAppPublicArgsV1 = {
  brief?: string;
  draftSpec?: unknown;
  replacementSpec?: unknown;
  runId?: string;
  expectedRevision?: number;
  targetBase?: { runId: string; revision: number; revisionId: string };
};

type PicoLoopPublicArgsV1 = {
  goal?: string;
  draftSpec?: unknown;
  replacementSpec?: unknown;
  acceptance?: AcceptanceInput;
  budget?: BudgetInput;
  onFail?: "replan" | "stop";
  runId?: string;
  expectedRevision?: number;
  targetBase?: { runId: string; revision: number; revisionId: string };
};
```

`draftSpec`/`replacementSpec` remain permissive public values so handler-level AppSpec diagnostics
remain compatible. `acceptance` retains its current criterion schema and minimum-one rule whenever
present; budget retains its current member schema. After this structural parse, the run layer
accepts only these mutually exclusive internal
invocation unions. `AppSpecInput` deliberately remains the current permissive `z.any()`/unknown
public value and is schema-parsed inside the handler so invalid drafts preserve current
`plan-failed` behavior; `AcceptanceInput` and `BudgetInput` are the current public shapes:

```typescript
type TargetBaseV1 = {
  runId: LowercaseUuidV4;
  revision: number;
  revisionId: Sha256;
};

type BuildAppInvocationV1 =
  | { mode: "coordinate-free"; brief: string; draftSpec?: AppSpecInput }
  | { mode: "initial-from-base"; brief: string; draftSpec?: AppSpecInput;
      targetBase: TargetBaseV1 }
  | { mode: "resume"; runId: LowercaseUuidV4; expectedRevision: number;
      brief?: string }
  | { mode: "author"; runId: LowercaseUuidV4; expectedRevision: number;
      brief?: string; draftSpec: AppSpecInput }
  | { mode: "amend"; runId: LowercaseUuidV4; expectedRevision: number;
      brief?: string; replacementSpec: AppSpecInput };

type ResolvedCoordinateFreeBuildV1 =
  | { mode: "initial"; brief: string; draftSpec?: AppSpecInput }
  | { mode: "legacy-scaffold-replay"; runId: LowercaseUuidV4;
      expectedRevision: number; brief: string }
  | { mode: "legacy-author"; runId: LowercaseUuidV4;
      expectedRevision: number; brief: string; draftSpec: AppSpecInput };

type PicoLoopInvocationV1 =
  | { mode: "initial"; goal: string; acceptance: AcceptanceInput;
      draftSpec?: AppSpecInput; budget?: BudgetInput; onFail?: "replan" | "stop";
      targetBase?: TargetBaseV1 }
  | { mode: "resume"; runId: LowercaseUuidV4; expectedRevision: number;
      goal?: string; acceptance?: AcceptanceInput; budget?: BudgetInput;
      onFail?: "replan" | "stop" }
  | { mode: "amend"; runId: LowercaseUuidV4; expectedRevision: number;
      replacementSpec: AppSpecInput; goal?: string; acceptance?: AcceptanceInput;
      budget?: BudgetInput; onFail?: "replan" | "stop" };
```

`mode` is internal and derived from field presence; it is not a new public input key. Initial fields
cannot coexist with `runId/expectedRevision`, `targetBase` is coordinate-free-initial-only, `draftSpec` and
`replacementSpec` are mutually exclusive, and `runId` and `expectedRevision` must appear together.
Any other mixture returns `invalid-invocation` with no run/store/external mutation. Resume-supplied
goal, acceptance, budget, and policy are assertions only. An invalid initial AppSpec preserves the
current pre-run `plan-failed` result without coordinates. An invalid authored `draftSpec` while
awaiting authoring returns `plan-failed` at the unchanged coordinate with no revision; an invalid or
state-ineligible `replacementSpec` returns `spec-conflict` at the unchanged coordinate. Invalid
policy returns `invalid-policy`; no invalid value is persisted.

The invalid authored-draft case is the one existing-run validation response outside the persisted
result path: it returns the accepted-base Door 1 `{status:"plan-failed",detail,fix}` shape plus the
current run coordinates and `unchanged/none` transport dispositions. It does not set `replayed`,
does not publish a public-result snapshot, and leaves the authoritative lifecycle
`open/awaiting-authoring`; a corrected draft retries the same expected revision. This is distinct
from an initial invalid draft, which is the coordinate-free `PreRunWorkflowFailureV1`, and from a
planner failure after valid durable intent, which is committed as paused `plan-failed`.

Door 1's accepted `{brief}` then `{brief,draftSpec}` protocol is a deliberate compatibility
resolver, not an unsafe general coordinate-free resume. With no `targetBase`, the handler derives
the application/project resource keys and physical project locator, takes the application then
physical-project locks,
and performs the complete bounded lineage read. If the
target is genuinely new it resolves to `initial`. If the unique unconsumed leaf has the exact raw
brief, an unchanged closed generation, and lifecycle `open/awaiting-authoring`, `{brief}` resolves to
`legacy-scaffold-replay` and `{brief,draftSpec}` resolves to `legacy-author` at that leaf's actual
HEAD. The latter then acquires the run lock before the application and physical-project locks in the normal global order,
re-reads both lineage and HEAD, and CAS-commits `spec-authored`; one of two concurrent authors wins
and the other returns `revision-conflict`/`target-conflict` without planning or Fleet work. The
initial application/project discovery pair is released before acquiring the ordered
run→application→project trio, and
the second read is authoritative, so there is no lock inversion or stale implicit expectation.

No other open, paused, blocked, in-doubt, terminal, ambiguous, corrupt, or byte-different leaf is
implicitly selected. Those cases require explicit run coordinates or, for a new child of a terminal
leaf, `targetBase`. Supplying `targetBase` always selects `initial-from-base` and never hijacks an
awaiting-authoring run. This narrow adapter preserves AGENTS.md's exact two-step syntax while the
coordinate-bearing authored continuation remains preferred.

Validation precedence is exact: public structural parse; invocation-form/run-ID grammar; initial
intent/AppSpec validation; coordinate-free Door target discovery and its authoritative ordered-lock
recheck when applicable; or, for explicit resume, lock acquisition, complete store read, and
`expectedRevision`; then optional intent assertions; lifecycle/spec gate; generation/capacity
checks; bounded external-input collection/publication, sealed-view materialization, and capability
creation; `attempt-started` publication; and external
execution. Thus stale revision wins over a
candidate replacement-spec error, while `run-busy`/`invalid-store` wins when no stable head can be
read. No coordinate-free discovery allocates a run until it has resolved to a genuinely new target.

The lifecycle/spec gate is closed. Door `awaiting-authoring` with no spec replays and with
`draftSpec` authors; `replacementSpec` conflicts. Open `ready-to-plan/ready-to-build` with no spec
continues and any supplied spec conflicts. An eligible pause with no spec retries and only an
explicitly permitted `replacementSpec` amends. Terminal with no spec replays and any supplied spec
conflicts. Blocked/in-doubt always returns its control result. `pico_loop` never enters
`awaiting-authoring`.

After normalizing the goal/acceptance/policy and schema-parsing any caller-supplied AppSpec, an
initial call publishes revision zero in `ready-to-plan` before invoking the planner. Revision zero
therefore contains every input needed to repeat planning after a process restart. A planner/lint
result is committed as `plan-completed` before the workflow returns or starts mutable project work.
Invalid acceptance or an AppSpec that cannot pass the AppSpec schema is not durable workflow intent
and preserves the existing pre-run failure result without run coordinates.

### Door 1

Supported forms are:

- initial scaffold: `{brief, targetBase?}`;
- initial direct build, retained for compatibility: `{brief, draftSpec, targetBase?}`;
- preferred authored continuation: `{runId, expectedRevision, draftSpec}` while the head is
  `awaiting-authoring`;
- ordinary retry: `{runId, expectedRevision}` for a retryable paused state; and
- explicit repair: `{runId, expectedRevision, replacementSpec}` for a state that permits manual
  amendment.

An optional `brief` on a resume is only a digest assertion. Initial and resume fields may not be
mixed ambiguously. A legacy `{brief,draftSpec}` call continues only the exact unique
`awaiting-authoring` leaf described above; on a genuinely new target it creates a direct-build run,
and on any other occupied target it refuses to guess. `targetBase` explicitly creates a new child
only from an eligible terminal lineage leaf.

A brief-only call first stores the normalized goal, then stores the parsed planner scaffold in the
`plan-completed` revision and returns the existing `needs-authoring` result plus run coordinates. A
coordinate-free retry of that exact brief replays the same scaffold without another revision. A
direct initial draft is schema-parsed and stored in revision zero before planning. On an authored
continuation, the schema-parsed draft is committed as `spec-authored` in `ready-to-plan` before the
planner/linter call, so a crash during that read-only phase does not require the draft again.
Planner/lint success then commits `ready-to-build`; failure commits a paused `plan-failed` state.
Every build attempt collects and publishes its bounded external-input manifest, completely seals
and validates the token-owned view, creates the local capability, and only then atomically commits
the ref in `attempt-started` before invoking Fleet with the immutable run-owned brief payload and
that capability.

### `pico_loop`

Supported forms are:

- initial: `{goal, acceptance, draftSpec?, budget?, onFail?, targetBase?}`;
- resume: `{runId, expectedRevision}` with optional goal/acceptance/policy assertions; and
- explicit repair: `{runId, expectedRevision, replacementSpec}` in a paused state that permits it.

The root revision stores normalized acceptance, policy, target identity, the next iteration index,
and any schema-valid caller draft before planning. When no draft was supplied, its current spec is
null and the stored goal is sufficient to repeat the planner after restart. `plan-completed` adds the
parsed planner output before any fleet work. Each iteration publishes a fresh external-input
manifest, completely seals its view/capability, and then publishes `attempt-started` before the iteration's adb logcat reset or run-owned
brief-payload/Fleet pipeline, then one outcome revision containing
compiler/receipt/criterion results and either the replanned current spec, a paused reason, or the
current terminal status. `iterationsLog` is reconstructed deterministically from immutable
iteration outcome revisions and retains its current public shape.

There are no hidden mid-iteration resume checkpoints. A receipt published after `attempt-started`,
criterion results held only in memory, or a replanned object not yet named by an outcome HEAD may be
reported as bounded orphan diagnostics but is never reused. A restart at any of those cuts returns
`interrupted-in-doubt` and retains the attempt locks. Only planning/open state, an ordinary paused
outcome, or a HEAD-durable `iteration-completed` revision carrying the next current-spec ref can
continue in the same run.

### `pico_next`

`pico_next` reads valid run heads first and emits an exact continuation using
`{runId,expectedRevision}`. Its current brief/project/receipt scan remains only as a disclosed
legacy fallback for artifacts created before this store. Corrupt runs are reported rather than
silently skipped in favor of an apparently usable older artifact. Root enumeration is streaming
and stops with `limit-exceeded` rather than selecting from a partial candidate set.

V1 run discovery never depends on, synthesizes, or points an action at
`~/.pico-mcp/briefs/<id>.json`. For a selected V1 run, the situation and action are derived only
from the validated immutable goal, acceptance, policy, spec/brief-payload, lifecycle, result, and
target snapshots named by that run's chain. The action carries run coordinates, or for the one
explicit provenance-rebuild branch the exact immutable initial inputs plus `targetBase`; it never
asks the caller to retrieve a compatibility brief that V1 deliberately did not create. The
existing top-level `state.briefs` array remains the unchanged legacy user-brief scan and therefore
need not contain V1 applications; additive `state.runStore` is their authoritative discovery and
routing surface. The legacy brief-derived action algorithm is reachable only under the no-V1-leaf
fallback described below.

Discovery validates every referenced external-input snapshot as immutable core CAS state but does
not reopen its mutable source paths. An eligible action remains `{runId,expectedRevision}`; the
workflow call, under its execution locks, collects the next attempt's fresh manifest. Terminal
replay likewise performs no asset hashing. `pico_next` therefore neither hides current asset drift
nor turns it into historical evidence, and its public schema needs no asset-specific field.

Root leaves have exact classes:

- valid reserved internal `objects`, `locks`, and `staging` directories count toward enumeration
  bounds but neither become candidates nor suppress legacy fallback; a wrong-type or unsafe reserved
  path is unknown/corrupt presence;
- any other root entry—including a canonical UUID of any file type, malformed/unsafe run-like
  name, recognized run staging name, or unknown leaf—is V1/unknown presence, is reported, and
  suppresses legacy fallback;
- a valid core open/paused head is eligible;
- a live running, `attempt-started`, `attempt-in-doubt`, blocked external conflict, or
  recovery-required head is a blocker;
- a valid core terminal head is a terminal candidate; and
- an unsafe/corrupt/missing candidate is invalid.

Selection is deterministic only after the complete bounded core scan: any exceeded core aggregate
budget returns `limit-exceeded`; otherwise the newest eligible head wins, then the newest hard
blocker, then the newest terminal candidate. Only that selected run receives current receipt and
auto-judge revalidation under the external-work budgets. If its terminal authority is broken, its
final selection becomes `blocker/provenance-broken`; a broken unselected older terminal neither
overrides a newer terminal nor consumes external hashing work. If selected authority work exceeds
its aggregate budget, the whole result is `limit-exceeded`, not a partial projection. If V1/unknown
presence exists with no valid candidate, the result is
`invalid-store`. Legacy fallback runs only when the root contains reserved internal entries and no
other leaf. Within each class, candidates order by routing timestamp descending and lowercase
`runId` ascending. An ordinary candidate's timestamp is `HEAD.updatedAt`; a valid recoverable
publication tail uses the tail revision's `createdAt`, including revision zero when HEAD is absent
and a lagging-HEAD tail whose HEAD is older. These canonical wall timestamps are only routing
preferences, never revision order, lock age, workflow identity, recovery authority, or elapsed-time
inputs. Invalid/blocking entries remain in bounded issues and set `degraded:true` even when an
eligible run is selected. A selected `provenance-broken` terminal is a blocker, never a historical
success candidate.

Target-base admission uses the same bounded candidate reader for the named predecessor and the
complete bounded application-resource lineage scan. It proves that the predecessor is the unique unconsumed
terminal leaf before publishing its one child; it never performs an unbounded search, branches a
consumed base, or silently chooses among partial results.

`pico_next` preserves its four current top-level keys—`situation`, `nextAction`, `alternatives`, and
`state`. Its exact additive contract is:

```typescript
type PicoNextActionV1 = {
  door: string;
  argsExample: JsonObject;
  why: string;
};

type PicoNextRunStoreStateV1 = {
  selection: "eligible" | "blocker" | "terminal" | "invalid-store" |
    "limit-exceeded" | "legacy" | "none";
  routingStatus: "eligible" | "terminal" | "run-busy" |
    "recovery-required" | "interrupted-in-doubt" |
    "external-state-conflict" | "provenance-broken" |
    "invalid-store" | "limit-exceeded" | "legacy" | "none";
  workflow: "pico-build-app" | "pico-loop" | null;
  runId: LowercaseUuidV4 | null;
  revision: number | null;
  revisionId: Sha256 | null;
  expectedRevision: number | null;
  storedLifecycle: LifecycleV1 | null;
  effectiveLifecycle: EffectiveLifecycleV1 | null;
  storedStatus: PublicWorkflowStatusV1 | null;
  effectiveStatus: EffectivePublicStatusV1 | null;
  projection: RunProjectionMetadataV1["projection"] | null;
  degraded: boolean;
  issues: BoundedDiagnosticV1[];
  issueCount: number;
  issuesTruncated: boolean;
  receiptProvenance: BoundedDiagnosticV1[];
  autoJudgeProvenance: RunProjectionMetadataV1["autoJudgeProvenance"];
};

type PicoNextResultV1 = {
  situation: string;
  nextAction: PicoNextActionV1;
  alternatives: PicoNextActionV1[];
  state: {
    preflightFailing: string[];
    emulatorRunning: boolean;
    cameraCalibrated: boolean;
    briefs: JsonValue[];
    runStore: PicoNextRunStoreStateV1;
  };
};
```

All keys are present. `routingStatus` supplies the exact branch within the coarser selection class.
An ordinary coordinate-bearing selection names its authoritative HEAD in all four
workflow/coordinate fields and has `expectedRevision === revision`. A `recovery-required` selection
instead names the one fully validated contiguous tail—including revision zero when HEAD is absent—
and uses that tail revision as `expectedRevision`; its routing status is the explicit disclosure that
this coordinate becomes authoritative only if the action's locked recovery publishes HEAD. This lets
one call recover and then re-evaluate the same expectation without pretending the pre-call HEAD had
already advanced. Non-run selections use nulls. `legacy` and `none` have null
lifecycle/provenance fields and preserve the current brief-scanning action algorithm. `issues`
contains the first 64 bounded diagnostics while count/truncation describe the complete bounded
scan. `alternatives` remains ordered and capped at three.

Branch-to-action mapping is closed. An eligible open/paused run names its workflow Door with
`{runId,expectedRevision}` (awaiting authoring additionally shows the actual scaffold as the draft
to adapt, sourced from the immutable spec snapshot rather than a user-brief path). A recoverable
tail names the same Door so its locked mutating read can recover. A live
owner names the same Door with an explicit wait/retry reason but no claim that the call will execute.
A provenance-broken terminal names a fresh initial call with its exact intent plus
`targetBase:{runId,revision,revisionId}`. For Door 1 that action contains exact `brief` and the
validated terminal `currentSpec` as `draftSpec`; for the loop it contains exact `goal`, normalized
acceptance projected back to the current public input shape, current spec as `draftSpec`, effective
budget/onFail inputs, and the base coordinate. The new run inherits no evidence, compiler state,
iteration state, or result. Other in-doubt or
external-conflict blockers name `pico_fix` with the exact bounded diagnostic and explicitly say V1
cannot unlock/reconcile that target. A terminal intact run names its workflow Door at the current
coordinate to replay. `invalid-store` and `limit-exceeded` name `pico_fix` and never fall back to a
legacy artifact. Existing environment/emulator/capability actions follow as alternatives only when
they do not contradict the selected run branch.

This does not replace the response with a run-store-specific top-level shape.

## Public failure results

Run-control results are one strict normalized envelope; every listed key is present and unknown keys
are rejected:

```typescript
type RunControlStatusV1 =
  | "invalid-invocation" | "invalid-policy" | "invalid-run-id" | "run-not-found"
  | "run-busy" | "revision-conflict" | "intent-conflict" | "acceptance-conflict"
  | "spec-conflict" | "target-conflict" | "recovery-required"
  | "interrupted-in-doubt" | "external-state-conflict"
  | "invalid-store" | "limit-exceeded" | "revision-limit" | "state-write-failed";

type RunControlResultV1 = {
  status: RunControlStatusV1;
  runId: LowercaseUuidV4 | null;
  revision: number | null;
  revisionId: Sha256 | null;
  expectedRevision: number | null;
  actualRevision: number | null;
  actualRevisionId: Sha256 | null;
  runStateByThisCall: "unchanged" | "durably-advanced" | "publication-in-doubt";
  externalSideEffectsByThisCall: "none" | "possible" | "confirmed";
  priorAttemptExternalSideEffects: "possible" | "confirmed" | null;
  activeAttemptExternalSideEffects: "possible" | null;
  inDoubtAttemptCompletion: "unknown" | null;
  runRevisionCommitted: boolean | null;
  runRevisionPublication: "not-linked" | "linked-head-pending" |
    "head-authoritative" | "unknown" | null;
  expectedGeneration: TargetGenerationV1 | null;
  observedGeneration: TargetGenerationV1 | null;
  historicalResult: BuildAppPublicResultV1 | PicoLoopPublicResultV1 | null;
  issues: BoundedDiagnosticV1[];
  detail: string;
  fix: string;
};
```

Input-shape/policy/ID failures and `run-not-found` have null coordinates. A valid existing-run
control result carries its current coordinate; corrupt state may retain only the validated input
`runId` and otherwise null coordinates. Only `revision-conflict` populates all three revision
comparison fields. Only `external-state-conflict` populates both generation fields. The
projection-only `provenance-broken` response uses `RunProjectionMetadataV1`, not this control
envelope. Control results therefore require `historicalResult:null`. Only a state-publication path
populates `runRevisionCommitted` and `runRevisionPublication`; all inapplicable fields are literal
null, not omitted. `runRevisionCommitted` means exactly that the new revision is authoritative
through durable HEAD, not merely that its immutable object was linked. The companion field
distinguishes a proven unlinked failure, a linked recoverable tail, a HEAD-authoritative commit, and
an observation too ambiguous to classify. `linked-head-pending` requires a publication-complete
revision target with no staging alias; a raw target+alias cut is store corruption, not this state.

The two disposition fields are transport metadata and never enter a public-result snapshot.
Run-store objects that become reachable from a durable revision/HEAD count only toward
`runStateByThisCall`; an unreferenced pre-attempt CAS object or temporary sealed view does not advance
logical run state. Read-only planning and lint do not count as external side effects.
`externalSideEffectsByThisCall` is `none` until the
orchestrator invokes the first post-`attempt-started` operation that may mutate project,
device/logcat, perf-report, receipt/ledger, install, or capture state. Pre-attempt manifest CAS and
token-owned view preparation are internal run preparation, not an external side effect. It is
`possible` when such an
operation was invoked but completion/mutation cannot be confirmed, and `confirmed` when any injected
phase boundary reports an acknowledged external mutation. A definite attempt that proves no such
mutation may remain `none`.

Rejection, conflict observed before an attempt, replay, and an observer of an older in-doubt attempt
use `unchanged/none`; the observer additionally sets
`priorAttemptExternalSideEffects` to the exact stored `possible|confirmed`. A recovered linked
`attempt-started` tail has no runner disposition and reports conservative `possible`. A live execution projected as `run-busy` sets
`activeAttemptExternalSideEffects:"possible"`. The initiating call for an ambiguous runner sets
`inDoubtAttemptCompletion:"unknown"` and `externalSideEffectsByThisCall:"possible"` unless a prior
acknowledged mutation makes it `confirmed`. A definitely completed attempt response reports the
orchestration-wide accumulator's exact `none|possible|confirmed` disposition. Issues and external
details are bounded and scrubbed.
No result claims that a project, emulator, installed package, or capture was restored.

## Bounds

V1 enforces these maxima before allocating or hashing untrusted content:

- 256 revisions per run;
- 512 KiB canonical bytes per revision;
- 4,096 total root entries encountered by any complete V1 root scan (`pico_next`, admission,
  coordinate-free Door discovery, or public Fleet lineage lookup), counting valid runs, reserved
  directories, staging names, malformed names, files, and unsafe/unknown entries;
- 4,096 non-reserved V1/unknown root candidates per complete root scan, matching the root
  enumeration ceiling rather than imposing a lower 64-run store-lifetime limit;
- 4,096 entries in each run/application/project lock namespace and 12,288 across all three for one
  complete coordination scan, counting active locks, recovery elections, and recognized release
  quarantines; at most eight entries inside any owner/election/quarantine directory;
- 1,024 entries across one run directory, including recognized staging leftovers;
- 65,536 aggregate nested run-directory entries and 16,384 aggregate revision envelopes per
  complete root scan;
- 32,768 unique CAS objects and 512 MiB of HEAD/revision/CAS canonical bytes per complete root scan;
- 2 MiB per AppSpec or external-input snapshot, 3 MiB per brief-payload snapshot, and 8 MiB per
  compiler-ledger snapshot;
- 4,096 compiler-ledger steps and 20,000 project-write records per compiler snapshot;
- 4 MiB per public-result snapshot and the recursive JSON shape limits defined above;
- 3 MiB per read-only compatibility user-brief payload;
- 64 components and 16 KiB UTF-8 for each requested/physical project-root, project-directory, or
  immutable input-base locator, charged during the stable ancestor walk;
- 256 logical external-input uses and 256 unique external files per sealed V1 execution (run attempt
  or public V1-backed Fleet call);
- 16 KiB UTF-8 per declared or resolved external-input path;
- 64 MiB each for semantic-scene/occupancy JSON with recursive JSON depth 32, 256 MiB per KTX, and
  512 MiB per model, sidecar, splat, or pano file;
- 2 GiB aggregate unique external-input bytes hashed/materialized per sealed V1 execution, charged before each
  descriptor is streamed; this V1 cap is an intentional fail-closed restriction while legacy Fleet
  remains unchanged;
- 256 KiB per original caller goal/brief before normalization;
- 64 KiB normalized goal;
- 64 acceptance criteria and 256 KiB canonical acceptance;
- six iterations, preserving the current public maximum;
- six accumulated native receipt refs per revision;
- 64 unique historical receipt validations, 64 unique auto-judge event validations, 2 GiB of
  receipt/capture/APK bytes hashed, and 64 MiB of trust-ledger bytes read for the one selected run
  (or one named target base) per root projection;
- 8 MiB and 4,096 events per individual auto-judge ledger, with 64 KiB/depth-32 event values;
- `budget.timeMin` in the inclusive finite range `0..1440`;
- 4 KiB per persisted diagnostic detail and 64 returned issue details, while retaining exact
  `issueCount` and `issuesTruncated`; and
- 512 MiB total unique snapshot bytes referenced by one run.

Before opening a referenced object, the reader charges its declared size to the applicable
counter; it then opens no-follow, `fstat`s the descriptor, charges the actual size, rejects a
mismatched declaration, and only then allocates, reads, or hashes content. A mismatch is corruption,
not a way around the budget.
Exceeding any aggregate budget returns `limit-exceeded` with no candidate selection and no legacy
fallback. A per-ledger authority overflow makes that exact auto-judge ref unverifiable, while a root
projection that cannot finish the selected run's required authority work returns `limit-exceeded`.
Unselected runs receive core validation only and do not spend external artifact/ledger budgets. Directory
enumeration is streaming and bounded. The store checks pending work before pushing it, does not sort
an unbounded directory in memory, and closes every descriptor, iterator, validator, and lock on
every success or failure path.

Run-store projection validates external-input snapshot envelopes and refs as core CAS bytes but does
not reopen or hash their mutable source files. Only a call about to start public/managed Fleet work
spends the bounded external-input hashing/materialization budget. `pico_next` and terminal replay
therefore do zero mutable-asset hashing and never turn current asset availability into historical
authority.

These are also finite active-store lifetime ceilings because V1 deliberately has no archival or GC
protocol. Reaching a root/CAS aggregate cap fails closed and the documentation must say so; it must
not advise deleting a run, shared object, or lineage edge by hand. A future archive/compaction
design must preserve target-base ancestry and evidence before it can relieve that ceiling. A
different run root is safe only for genuinely new, nonoccupied targets and is not a way to forget an
existing target's lineage.

## Test-first acceptance

Implementation begins with focused tests that fail because the new store and orchestration do not
exist. The suite must include:

### Identity, storage, and corruption

- canonical goal/spec/acceptance identities, default expansion, array-order preservation, and
  normalization conflicts, including CRLF/LF, NFC, and outer-whitespace variants that preserve the
  exact original `briefInput` and legacy mapping across restart;
- injected UUID collisions and distinct goals with the same `briefId`, proving neither existing run
  nor existing project is reused or overwritten;
- new-target admission, occupied target without a base, exact target-base admission, stale/wrong
  base, normalization-equal but byte-different brief, legacy target without V1 authority, and a
  completed same-goal target whose valid compatibility brief and selected project input were edited,
  the latter returning `target-conflict` with zero state/project/Fleet writes;
- one no-attempt zero-budget terminal serving as a closed-generation target base, followed by
  single-use base consumption; duplicate, branched, cyclic, non-leaf, and concurrently replayed
  bases all reject without allocating a second child;
- one receipt/auto-provenance-broken terminal with intact core generation serving as an explicit
  evidence-empty rebuild base, while core-corrupt or generation-broken variants reject;
- create/read/append, exact parent/revision ID, immutable old revisions, and canonical bytes;
- missing/corrupt/wrong-type CAS objects, noncanonical JSON, unknown keys/kinds/versions, gaps,
  filename mismatch, parent mismatch, and head mismatch;
- traversal attempts, absolute or noncanonical run IDs, symbolic-link components/leaves, hard-link
  leaves, replacement races, and outside-target preservation;
- compatibility-brief oversize, malformed/extra-key payload, symlink/hard-link leaf, and stable-read
  replacement race, proving V1 never creates or overwrites that leaf;
- immutable brief-payload publication/reuse, Fleet capability validation, replan payload replacement,
  and receipt authored-source binding that remains exact after the compatibility brief is changed or
  deleted;
- physical project locators for existing/absent roots, default/custom root aliases resolving to one
  target, ancestor replacement, symlink retarget, project delete/recreate with a changed stable
  path/device/inode generation, same-inode-reuse boundary disclosure, wrong post-scaffold real path,
  and outside-root resolution, each in-scope mismatch failing before an unauthorized inner call;
- external-input manifests covering semantic scene, occupancy, textured model, splat, pano,
  seat-model, model-sidecar, and IBL roles; duplicate ordered uses hash one file; missing, edited,
  deleted, newly appeared, symlink/hard-link/FIFO/directory, component-symlink, and
  lstat/open/mid-hash/post-hash replacement cases are all explicit;
- GLTF sidecar edits/missing/traversal/network URIs, bounded self-contained GLB, and rejected loose
  USD dependency ambiguity;
- exact and +1 external use/file/path/per-kind/aggregate/JSON-depth/manifest limits, with count and
  descriptor size charged before hashing, every external role copied/rehashed into the sealed view,
  semantic/occupancy consumers proven to use only the copies, originals closed before the attempt,
  and sealed files made read-only;
- every byte/count/directory/revision limit, including lock-namespace/owner-directory exact and +1,
  pending-work, and pre-hash enforcement; and
- a near-2-MiB valid AppSpec embedded in a scaffold result, run brief payload, and post-rewrite
  compiler ledger remaining publishable/readable under the independent 3/8/4-MiB envelopes, while
  each envelope rejects its own overflow; and
- root scans through `pico_next`, admission, coordinate-free Door discovery, and public Fleet whose
  4,097th encountered entry is reserved, malformed, staging, unsafe, or valid, each rejecting the
  entire selection rather than choosing from the first 4,096; public Fleet additionally proves that
  corrupt/unknown candidates suppress legacy fallback with `invalid-store`, and that a V1 lineage
  with a different application key but the same physical-project key suppresses fallback with
  `target-conflict`; and
- crash cuts before revision link, after target link but before staging unlink, after staging unlink
  but before directory flush, after that flush but before HEAD, after HEAD replacement, and during
  first HEAD creation, proving target+alias is retained `invalid-store` while only a
  publication-complete tail may advance.

### Concurrency and recovery

- multiple same-process and cross-process writers with the same `expectedRevision`, proving exactly
  one attempt and a contiguous chain;
- two run IDs sharing one application-resource key, and two different IDs/apps resolving to one
  physical project resource, proving neither the installed app nor project can mutate concurrently;
- a live owner beyond the old timeout, dead owner, PID reuse, malformed owner, reaper crash,
  replacement generation, process-identity probe failure before state, token-checked release, and
  directory durability;
- crashes after the first, second, and third execution-lock acquisitions but before
  `attempt-started`; a crash after its raw target link with the staging alias present; a crash after
  publication completion but before HEAD; and a crash after that HEAD, proving pre-target owners are
  reapable, any visible target retains all owners, only the publication-complete tail advances, and
  the latter cuts retain all three locks as in-doubt; plus `SIGKILL` after each reverse quarantine
  in pre-target cleanup, coordination release, and definite-outcome release, proving every remaining
  set is an authorized prefix and every suffix/skipped-middle set is invalid and retained;
- a public full-surface `fleet_build` call for the same ID while a V1 attempt is live and while its
  dead in-doubt owner is retained, each returning the additive busy/in-doubt coordination status
  with zero generator/Gradle/adb calls; plus exact public-Fleet started/completed marker
  staging/link/unlink/fsync, malformed/wrong-token, staging-only cleanup, visible-started retention,
  visible-completed recovery, and `SIGKILL` after completion link, completion flush, project-owner
  quarantine, and application-owner quarantine;
- default and custom-root spellings for one ID sharing the same application lock; a stable alias of
  the V1 project preserving generation checks; a genuinely different root returning
  `target-conflict` when V1 lineage exists; and two legacy calls for one ID/different roots never
  beginning concurrently; plus a later different-ID/application legacy call resolving to that same
  V1 physical project returning `target-conflict` after the earlier lock is released, with zero
  resolver/core call;
- public ID-only Fleet resolving a completed V1 Door's immutable payload with no user brief leaf;
  rejecting open/paused lineage with an exact workflow/`{runId,expectedRevision}`
  `coordinationContinuation`
  and zero manifest/marker/core call; rejecting ambiguous/awaiting/plan-failed lineage and a freshly
  mismatched or unobservable target generation before the shared core runs; selecting user `ibl/`
  only when safely present and
  otherwise the packaged corpus rather than the CAS directory, and preserving
  user-store-then-corpus lookup only when no V1 lineage exists;
- no-lineage public Fleet using the separate branded mutable compatibility capability with no
  external manifest/model-closure/2-GiB restriction, preserving the accepted user/corpus, model-path,
  missing/invalid, and custom-root behavior while still holding application/project locks;
- IBL user-absent→corpus, user-present→user, unsafe-user-directory fail-closed, no per-file corpus
  fallback after user selection, valid project-destination fallback, source/destination tamper, and
  custom-project selection under the held locator capability;
- missing external input repaired between ordinary attempts producing a different immutable input
  ref; source drift during collection/materialization producing no attempt revision or inner call;
  an original-source change after sealing leaving the current attempt bound to its sealed bytes and
  producing a different ref only on a later attempt; sealed-view tamper after `attempt-started`
  never yielding an accepted outcome; and a target-base child inheriting no prior attempt-input ref;
- one valid lagging tail recovery, missing/ahead head rejection, interrupted running state, an
  orphan child process despite unchanged selected inputs, an ambiguous timeout/disconnect retaining
  all three locks through normal `finally`, a matching durable outcome releasing all three, and changed
  project generation after interruption;
- `SIGKILL` during pre-attempt external-input materialization, with a fresh process proving no
  attempt revision, exact token cleanup/quarantine, owner reaping, and a safe later retry; plus
  `SIGKILL` after `attempt-started` as the core begins, retaining the interrupted-in-doubt owners and
  never reusing the sealed view;
- token-specific run→application→project recovery elections advancing an attempt tail while its ordinary locks
  remain occupied, rejecting live/token-changed owners, and never invoking external work;
- state-publication failure after an external success, proving no accepted public result; and
- forward/backward wall-clock discontinuities while the injected monotonic clock crosses the exact
  15-second lock and `timeMin` boundaries, proving wall time never controls elapsed decisions.

Durability cases use child-process barrier hooks, parent `SIGKILL`, and a separate fresh process to
reopen the store at snapshot/revision link, staging unlink, HEAD rename/fsync, each execution-lock
acquisition and reverse quarantine, public started/completed marker target-link/staging-unlink/
directory-fsync, public project/application quarantine, `attempt-started` revision/HEAD, external
success, outcome link, and outcome HEAD cuts.
A surviving grandchild after the outer process dies must retain the in-doubt block. Separate
injected fsync/directory-fsync failures prove call-order/error handling; neither harness alone is
described as a power-loss test.

### Door and loop behavior

- Door 1 scaffold creation, ID-only authored continuation, legacy direct build, retry, explicit
  amendment, target-base new run, lost-scaffold replay, terminal exact-result replay, and all current
  result fields;
- the literal AGENTS.md `{brief}` then `{brief,draftSpec}` sequence resolving the unique
  awaiting-authoring leaf, duplicate/concurrent coordinate-free authors, and every occupied target
  that must refuse implicit selection;
- loop resume after process restart from `ready-to-plan`, `ready-to-build`, a
  HEAD-durable completed-iteration/replanned-spec checkpoint, and an ordinary paused outcome;
- crashes after `attempt-started`, after receipt publication, during criterion evaluation, or during
  replan before the outcome HEAD, each returning `interrupted-in-doubt`, retaining all three execution
  locks, and never reusing the old PID, capture, partial outcomes, or replanned object; no same-run or
  same-target automated reconciliation/unlock path exists;
- exact Fleet post-rewrite ledger/dispositions, scaffold reuse, native-stage mapping, confirmed vs
  unconfirmed generator outputs, project write-set attribution, successful receipt/source equality,
  unrelated surviving project edits, and a definite `attempt-conflicted` HEAD released only after
  durability;
- repeated writes to one manifest/source path chaining exactly, restored-net writes remaining
  auditable, broken intermediate chains rejecting, and definite/in-doubt external mutation
  dispositions surviving restart without `confirmed` degrading to `possible`;
- strict rejection of impossible Fleet compiler/result/receipt cross-combinations, accepted-base
  native recorded/failed result compatibility, and post-receipt ambiguity retaining only the exact
  independently validated receipt plus succeeded compiler summary;
- outer `fleet-build`, late panel/acceptance, and `structural-ledger` response-loss phases, proving a
  late attempt ambiguity retains known compiler state but never invents a ledger outcome;
- `timeMin` negative, zero, fractional, 1440, above-1440, and JSON-nonfinite cases, including
  pre-attempt zero expiry using `policy-terminal` with no attempt ID, plus a lost terminal
  response replayed at the current coordinate without another result revision or external call;
- paused-at-final-iteration resume committing `iteration-budget-exhausted` with no new attempt;
- exact `runStateByThisCall` and `externalSideEffectsByThisCall` dispositions on every workflow and
  control result, including definite-no-write, confirmed mutation, initiator ambiguity, live owner,
  and old in-doubt observer;
- every valid and invalid invocation-union form; stale revision, changed goal, changed acceptance
  order/content, changed effective policy (but not inert `toolCalls`), and changed spec rejected
  before inner MCP or project calls;
- exact iteration-log reconstruction and current status compatibility;
- authoritative `pico_next` continuation, blocked/provenance-broken projection, reserved-only legacy
  fallback, and canonical-UUID file/symlink, corrupt-only, malformed/unknown, staging-only, mixed
  eligible/blocker/terminal, and every aggregate-budget boundary;
- exact `pico_next.state.runStore` nullability and action mapping for every selection class,
  including a provenance-broken terminal starting one evidence-empty child from its exact base,
  and every selected V1 action resolving immutable run snapshots without a user-brief leaf or a
  `~/.pico-mcp/briefs/<id>.json` path while the legacy `state.briefs` array stays unchanged;
- a counting/throwing external-input collector/materializer seam with original model/IBL sources
  deleted, replaced, or hostile after commit, proving `pico_next` and terminal replay make exactly
  zero mutable-source calls and still project immutable CAS history, while an actual ordinary retry
  invokes one fresh bounded collection and publishes a new input ref;
- strict public-result and coordinate-free pre-run unions, including forbidden cross-status keys;
- unchanged 18-tool surface and text JSON transport.

### Receipt and evidence honesty

- wrong-app/wrong-capture receipt rejection before publication;
- receipt valid at commit then missing/tampered on read, with immutable history retained and
  effective provenance downgraded;
- historical receipt intact but current source drifted, with history readable and current reuse
  rejected;
- receipt-bound calibrated PASS capped at `auto_judged`;
- missing/rejected visual-ledger write capped at `structural`, and an exact validated producer event
  sustaining `auto_judged` only while its app/sequence/digest/receipt/capture/provenance remain
  effective;
- missing, changed, broken, or retracted stored auto-judge event downgrading only the effective
  ceiling, never retro-upgrading from a later row, and invalidating a visual-dependent acceptance;
- a broken older iteration event leaving a later independently supported acceptance intact while
  forcing authority-stripped history, with aggregate auto-judge issue ordering/count/truncation and
  the 64-unique-event ceiling tested before partial projection;
- the same-iteration recorded eye PASS with no visual criterion preserving the accepted-base
  `auto_judged` ceiling, then losing that event through an authority-stripped structural projection
  without invalidating the independently nonvisual acceptance; duplicate visual criteria instead
  all bind the one exact event and become provenance-broken together if it is lost;
- unscored or escalated visual result retaining the exact remaining LOOK obligation;
- a receipt- or exact-auto-dependent stored success replaying with primary
  `status:"provenance-broken"`, unsafe success fields only in `historicalResult`, and an
  additive-unaware client unable to observe top-level `accepted` or `autoJudgedRecorded:true`;
- authority-stripped iteration summaries omitting visual outcomes/verdict/check/recorded-evidence
  fields, and auto-downgraded Door results omitting unstructured notes that may repeat the lost eye
  claim;
- per-ledger byte/event/value overflow producing exact unverifiable authority, and aggregate
  receipt/APK/ledger projection work producing `limit-exceeded` without partial selection; and
- attempted persisted `vision_verified` or `device_verified` rejected by schema.

The focused run-store suite receives its own package script and CI gate. Existing receipt, ledger,
Doors, semantic, distribution, documentation-metadata, and broad battery gates remain regression
gates. Tests use injected clocks, UUIDs, filesystem roots, process identity, inner MCP calls, and
receipt validators; they do not claim a live emulator, hardware, Windows, or rendered LOOK.

## Documentation and measured claims

Implementation updates `README.md`, `QUICKSTART.md`, `SKILLS.md`, `CAPABILITIES.md`, and the CI and
collaborator test ledgers with additive initial/resume examples and the exact evidence boundary.
Examples must retain the two-step Door 1 protocol and explicitly distinguish workflow resume from
emulator/source/install rollback.

Every task commit states the exact RED and GREEN commands, counts, and exit status that actually
ran. No commit or documentation may claim Swan behavior, hardware Safeguard, native Windows,
rendered appearance, or visual verification without that exact evidence. The complete focused
implementation receives an independent specification and code review before Subproject 4 begins.

## Acceptance criteria

V1 is complete only when:

1. Door 1 and `pico_loop` return durable `{runId,revision}` coordinates without removing current
   fields or statuses, and the literal AGENTS.md `{brief}` then `{brief,draftSpec}` sequence remains
   a safe single-leaf continuation.
2. A fresh process resumes an open, ordinary paused, or definitely completed checkpoint from
   `{runId,expectedRevision}` without the caller resending the full AppSpec; an in-doubt execution
   remains explicitly non-resumable.
3. Two stale/concurrent revisioned writers, or a revisioned writer and public `fleet_build`, cannot
   both begin side-effectful work on the same application resource or physical project resource,
   including different `projectsRoot` spellings for one ID and different IDs whose locators alias
   one directory. A later clean-looking legacy call also cannot mutate a physical project owned by
   another V1 lineage, and public Fleet cannot execute out of band against an open/paused V1 leaf;
   directly invoked raw low-level tools
   remain outside the explicitly stated coordination boundary.
4. Changed goal, acceptance, policy, current spec, compatibility brief, or surviving selected
   project input outside the exact validated Fleet write set cannot be silently folded into the same
   workflow generation. Every external host input consumed by an attempt is named by that attempt's
   immutable bounded manifest; a later repaired input receives a new attempt ref, while drift during
   collection/materialization or drift of the sealed consumed bytes cannot yield an accepted
   outcome. Mutation of an original path after sealing cannot alter the current attempt and affects
   only a later manifest. Concurrent non-cooperating writes to the same
   declared generated project leaf during its authorized write remain outside the stated V1 threat boundary.
5. A crash at each publication, lock-acquisition, or reverse-release boundary yields one documented
   recovery/error state; public Fleet releases neither resource without durable definite-completion
   authority, and no cut fabricates success.
6. Core state corruption, unsafe paths, exceeded bounds, or missing snapshots fail closed without
   overwriting evidence.
7. Receipt refs remain historically revalidated, current source reuse remains independently
   checked, a broken authority is not replayed as top-level success, and run history never upgrades
   structural evidence into visual proof.
8. Resume never promises emulator, source-tree, installed-app, Swan, hardware, native-Windows, or
   visual-state restoration.
9. The focused suite and all required regression gates pass with measured claims, and an
   independent reviewer reports no unresolved Critical or Important finding.
