# SpatialAgentBench Premeasurement Contract Amendment

**Date:** 2026-08-16

**Status:** Approved before measurement

**Scope:** Correct the benchmark evidence contract without running a model, emulator, device, or
measured cohort

## Why this amendment exists

No measured attempt used the old corpus identity
`449ba40d15eb60d96b9a1572b6d2fecfc41f1072bee2846701c48895f47b7f70`. The benchmark therefore
revises the existing `v1/` corpus in place instead of creating a misleading measured-v2 cohort. The
old identity remains recorded as superseded with `measuredAttempts: 0` and must never label a later
attempt.

This amendment separates four things that the original draft could conflate:

1. the source/typed-fact structural rubric;
2. whether the guarded project build qualified;
3. model-authored submission-test results; and
4. an application-self-reported instrumentation transcript.

None of those is external behavior, visual verification, device verification, or PICO sign-off.

## Binding decisions

- Corpus schema, corpus revision, rubric, and result schema are version 2. The ordered app protocol
  remains version 1.
- The fourth state rule is `state.reopen-wiring`. It checks source wiring from a retained store or a
  typed snapshot into reopen construction. Model-authored tests do not earn a rubric point.
- The 0–16 diagnostic is `structuralScore`. Its build-gated aggregate is
  `buildQualifiedStructuralScore`; a failed or unrun build produces zero while retaining structural
  diagnostics. No delivery, behavioral, or sign-off score exists.
- Submission tests use evidence class `submission_test`. The runtime protocol uses
  `app_self_reported_protocol`. `external_observation` is reserved and is emitted by neither this
  amendment nor the structural scorer.
- Five matched pairs may be labeled `preliminary_structural`. Ten frozen pairs meeting the
  statistical, build, and axis bars may be labeled `structural_threshold_met`. Successful protocol
  instrumentation may additionally be labeled `instrumentation_threshold_met`. These labels do not
  establish that the application works.
- The comparator is Claude Opus 5 with pinned `@picoxr/pico-cli@0.4.2` through the later
  sandboxed/scanned Bash gateway and no PICO-domain MCP. It is not a zero-MCP lane: every lane gets
  the same `agentbench-workspace` MCP. The treatment alone additionally gets the frozen 18-door
  `pico-spatial` MCP.
- Claude Code 2.1.233, normal Max OAuth/Keychain authentication, and its provider connection form a
  trusted supervisor assumption. Runner-owned hooks, gateway, workspace server, and PICO proxy are
  also security-critical trusted mediators but receive no Claude credential. Model-controlled and
  post-submission processes remain outside that trust zone.
- The rendered user prompt is identical across all lanes. It names no lane, MCP server, MCP tool,
  pico-cli command, scorer rule, implementation API, or evidence class.
- Corpus identity binds the exact bytes of the user prompt, system prompt, common workspace tool
  objects, full PICO door tool objects, protocol vectors, manifest, and pinned pico-cli toolchain
  files.
- The old schedule/API/CLI vocabulary has no executable compatibility alias. The only threshold
  names are `createStructuralThresholdSchedule`, `runStructuralThresholdCohort`,
  `--cohort structural-threshold`, `structural_threshold_met`, and
  `structural_threshold_not_met`. Pair and lane-order streams are independently seeded with
  `structural-threshold-primary` and `structural-threshold-primary-lanes`; the latter shuffles five
  copies of each lane order and is therefore exactly balanced.

## Task 3 prerequisite corrections

These corrections bind the reviewed source and receipt interfaces before any measurement.

### Supported-subset analyzer authority

Task 3 starts from required ancestor
`258ad3a9968d3a91991b513123e139e1cc60b608`. This is the pre-amendment ancestor, not the
post-amendment starting `HEAD`. Before analyzer implementation, this amendment and its implementation
plan must be the only two tracked paths modified by one direct-child commit with subject
`docs(bench): bind subset-v1 analyzer boundary`. The reviewed 40-hex SHA of that commit becomes the
exact Task 3 starting `HEAD`; an ancestor-only or later-descendant checkout is insufficient.

The Task 3 analyzer is `supported-subset-abstract-interpreter-v1`: Kotlin compiler 2.0.0 PSI is only
the syntax front end, and a frozen incomplete domain model supplies conservative source declaration
resolution, callback/effect summaries, bounded control flow, origin/alias tracking, and def-use.
This is not general Kotlin, Compose, Spatial SDK, runtime, or behavioral proof. A passing source
rule establishes only a source witness accepted under analyzer subset v1. Every passing source-rule
reason begins exactly `supported-subset-v1 witness:`. “Reachable,” “flows,” and “same authority”
refer only to the accepted modeled source graph, def-use/effect model, and origin abstraction.
Unknown or ambiguous syntax, receiver or return type, member/extension/overload dispatch, callback,
effect, aliasing, operator, or control flow makes the affected proof false.

### Reviewed Batch 2A follow-up authority

Batch 2B may not widen the Batch 2A snapshot or domain vocabulary under its existing approval. It
therefore stops at the sanctioned RED and requires a second two-document authority commit whose
sole parent is `5af6e162d253524b4cc0b06c7ca543eaaee5f024`, whose subject is exactly
`docs(bench): authorize subset-v1 follow-up repair`, and whose only modified paths are this
amendment and `docs/superpowers/plans/2026-08-16-spatial-agent-bench.md`. The independently reviewed
40-hex SHA of that commit becomes `TASK_3_BATCH_2A_FOLLOWUP_AUTHORITY_SHA`; it authorizes only a
separately SHA-frozen, independently approved ignored follow-up brief, not implementation by itself.

That follow-up may repair only anonymous-declaration indexing, exact `if`/`while`
condition-container recognition, and the dead standard-fixture `fun instance()` collision; add
only abstract types `immersion`/`modifier`, callback roles `inline_block`/`remembered_factory`,
invocation model `immediate_inline`, and return-origin-only effect marker `passthrough`; and
recognize only exact domain-row names in the default-import packages `kotlin`,
`kotlin.collections`, and `kotlin.ranges`. The allowlist is `kotlin.with`, `kotlin.apply`,
`kotlin.let`, `kotlin.runCatching`, `kotlin.repeat`; `kotlin.collections.List`,
`kotlin.collections.emptyList`, `kotlin.collections.toList`, `kotlin.collections.isEmpty`,
`kotlin.collections.isNotEmpty`, `kotlin.collections.forEach`, `kotlin.collections.filter`,
`kotlin.collections.maxByOrNull`, `kotlin.collections.firstOrNull`; and
`kotlin.ranges.until`/`kotlin.ranges.coerceAtLeast`. The audited symbol authority also covers
`androidx.compose.runtime.remember`, `com.pico.spatial.ui.foundation.dsl.Immersion`,
`androidx.compose.ui.Modifier`, and `androidx.compose.foundation.layout.fillMaxSize`.
`passthrough` forwards an equal, non-null-typed modeled receiver. Otherwise it forwards a callback
result only when `returnAbstractType` is `null` and exactly one immediate-inline callback has one
non-escaped, unambiguous result. A non-null type mismatch or a missing, multiple, escaped, or
ambiguous callback result remains unknown. It supplies no execution, mutation, reachability, or
behavioral fact. `remembered_factory` additionally records that callback-result origin as retained
without making it a strong state authority.

Default-import recognition is lower precedence than a lexical/source declaration or an explicit
import/alias and requires a unique audited domain row, a known receiver where applicable, and an
unambiguous supported overload. It is not wildcard, general Kotlin default-import, or stdlib
inference; `kotlin.math.*`, `kotlinx.*`, Compose, Android, and PICO names require explicit imports.

The closed vocabulary is mirrored identically in the Java domain loader, JavaScript bridge
validator, deterministic build validator, and analyzer test's literal registry assertions. It is
not serialized as new `domain-v1.json` schema keys. The follow-up keeps the canonical domain bytes
and clone-canary rows unchanged; Batch 2B owns new symbol rows. Its implementation scope is exactly `build-analyzer.mjs`, `PsiIndex.java`,
`Rules.java`, `kotlin-analysis.mjs`, `test/agentbench-kotlin-analysis.mjs`, and the previously
untracked `test/helpers/agentbench-fixture.mjs`. The fixture helper is `A` in the follow-up and `M`
on Batch 2B re-entry; the persistent score RED remains untracked until Batch 2B.

The follow-up succeeds only when the minimally amended raw fixture is accepted with zero claims and
the persistent thirteen-claim oracle fails solely for absent emitters. It then requires
clean-build-twice, exact identity re-pinning, the exact implementation subject
`fix(bench): repair subset-v1 snapshot boundary`, an ignored report, and an independent
commit-scoped `APPROVED` review. All protocol/subset/domain versions, analyzer name,
response/rejection schema, `Main.java`, `Protocol.java`, rule/proof/alternative/witness registries,
limits, the exact three-false oracle vector, and evidence ceilings remain frozen.

Task 3 remains structurally capped. Its result is still exactly `ScoreResultV2` below, including
`structuralScore`, `buildQualifiedStructuralScore`, submission-test separation, not-run runtime
protocol defaults, and `visual.status: "not_performed"`. Analyzer protocol, artifact, classpath,
JDK, receipt, and source-set identities are internal scoring/preflight provenance and do not add a
rubric point, delivery score, behavioral claim, or new public result field in Task 3.

### Complete Kotlin input and result rule

The bridge transports every selected `SourceIndex` file with `kind === "kotlin"`, both `.kt` and
`.kts`, in one sorted bounded request and one `kotlinInputSetSha256`. The sidecar validates every
file receipt and that complete digest before creating PSI. Any selected `.kts`, any extension other
than `.kt`, any PSI parse error in any selected `.kt`, incomplete or ambiguous global declaration
or import indexing, exceeded limit, or internal analysis uncertainty rejects the complete Kotlin
analysis. A rejection returns no nodes and no claims. The scorer then makes all sixteen source
rules false, including both `source_and_typed_fact` mixed rules even when their typed facts exist.
Protocol, launch, receipt, artifact, digest, or impossible-response failures throw instead of
returning a partial score. `build.gradle.kts` and `settings.gradle.kts` remain Gradle inputs handled
only by the typed Gradle parser; they are not Kotlin program declarations.

`kotlinInputSetSha256` is the SHA-256 of canonical JSON over sorted
`{path,bytes,sha256}` rows for the complete selected Kotlin set. `selectedInputSetSha256` is the
SHA-256 of canonical JSON over sorted `{path,kind,bytes,sha256}` rows for every selected Kotlin,
Gradle/catalog, and manifest input. Neither identity is a complete Gradle-input or build identity;
the guarded build receipt remains authoritative for the build.

### Task 3 tracked and ignored scope

Only these seven checkpoint paths may be retained/replaced:

```text
benchmarks/spatial-agent-bench/lib/rules-spatial.mjs
benchmarks/spatial-agent-bench/lib/rules-state-plane.mjs
benchmarks/spatial-agent-bench/lib/score.mjs
test/agentbench-fixture-compile.mjs
test/agentbench-score.mjs
test/helpers/agentbench-fixture.mjs
test/helpers/agentbench-junit.mjs
```

Task 3 may add only these analyzer paths:

```text
benchmarks/spatial-agent-bench/lib/kotlin-analysis.mjs
benchmarks/spatial-agent-bench/analyzer/.gitignore
benchmarks/spatial-agent-bench/analyzer/domain-v1.json
benchmarks/spatial-agent-bench/analyzer/dependencies-v1.json
benchmarks/spatial-agent-bench/analyzer/toolchain-v1.json
benchmarks/spatial-agent-bench/analyzer/build-analyzer.mjs
benchmarks/spatial-agent-bench/analyzer/src/main/java/com/agentbench/analyzer/Main.java
benchmarks/spatial-agent-bench/analyzer/src/main/java/com/agentbench/analyzer/Protocol.java
benchmarks/spatial-agent-bench/analyzer/src/main/java/com/agentbench/analyzer/PsiIndex.java
benchmarks/spatial-agent-bench/analyzer/src/main/java/com/agentbench/analyzer/AbstractInterpreter.java
benchmarks/spatial-agent-bench/analyzer/src/main/java/com/agentbench/analyzer/Rules.java
test/agentbench-kotlin-analysis.mjs
test/helpers/agentbench-analyzer-corpus.mjs
test/helpers/agentbench-gradle-cache.mjs
test/fixtures/agentbench/fake-analyzer.mjs
test/fixtures/agentbench/fixture-gradle-cache-v1.json
```

The tracked analyzer-local `.gitignore` owns only these generated locators:

```text
benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/
benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/analyzer-v1.jar
benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/analyzer-build-receipt-v1.json
benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/runtime/01-kotlin-compiler-embeddable-2.0.0.jar
benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/runtime/02-kotlin-stdlib-2.0.0.jar
benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/runtime/03-kotlin-script-runtime-2.0.0.jar
benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/runtime/04-kotlin-reflect-1.6.10.jar
benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/runtime/05-kotlin-daemon-embeddable-2.0.0.jar
benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/runtime/06-trove4j-1.0.20200330.jar
benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/runtime/07-annotations-13.0.jar
benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/run-cwd/
benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/run-home/
benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/run-tmp/
benchmarks/spatial-agent-bench/analyzer/.artifacts/fixture-gradle-seed-v1/
```

Everything below `.artifacts/` is generated, ignored, untracked, and excluded from npm. No other
Task 3 path is authorized. In particular Task 3 does not modify `source.mjs`, `contract.mjs`, corpus
inputs, `appskeleton/`, package or CI files, root dependencies, private reports, or the Windows lane.

### Analyzer artifact and fixture qualification

The sidecar is Java source compiled directly by the pinned JBR `javac`; analyzer assembly invokes
no Gradle and performs no dependency resolution. The reproducible output is a deterministic thin
JAR containing analyzer-owned classes and the exact tracked `domain-v1.json` only. Runtime uses
that JAR plus the seven byte/hash-pinned Kotlin compiler/stdlib/script/reflect/daemon/trove/
annotations JARs in the numbered order above. Two builds in distinct temporary roots must produce
byte-identical JARs before publication. The self-hashed receipt binds every analyzer source/config/
dependency/toolchain/build-script/bridge byte, the ordered runtime classpath, complete allowed JDK
tree, analyzer JAR, domain and protocol/subset versions, canonical runtime launch vector, and the
scrubbed build/runtime environment projections.

The build orchestrator is the content-pinned Node executable and rejects `NODE_OPTIONS`,
`NODE_PATH`, nonempty `process.execArgv`, and any environment other than the current reviewed Darwin
projection `LANG=C`, `LC_ALL=C`, `TZ=UTC`, and
`__CF_USER_TEXT_ENCODING=0x1F5:0x0:0x0`. Each absolute `javac` and `jar` child receives only the
reviewed allowlist and both receipt-bound `-J-Duser.home=$BUILD_HOME` and
`-J-Djava.io.tmpdir=$BUILD_TMP` arguments. Runtime uses absolute receipt-supplied `java`, an exact
eight-entry classpath, empty runner-owned cwd/home/tmp directories, a scrubbed no-`PATH`/no-proxy/
no-tool-options environment, and explicit `-Duser.home`/`-Djava.io.tmpdir`. Missing or mismatched
source, artifact, dependency, JDK, domain, bridge, receipt, cwd, environment, or launch identity
fails before scoring.

Every accepted form in the frozen `POSITIVE_SUBSET_V1_CASES` matrix must have at least two
compile-valid independently named examples. Each row names exact source hashes and exactly one of
one to eight complete Spatial SDK 0.13.3 compile aggregates. A bijection gate rejects missing,
duplicate, or orphaned rows/sources. Every aggregate must run a fresh offline
`:app:testDebugUnitTest` containing one pure compile-smoke test, and must preserve one identical
`selectedInputSetSha256` at the four checkpoints before analysis, immediately before assembly,
immediately after assembly, and after JUnit. PSI acceptance alone never earns “compile-valid.”

### Corrected attack vectors

The fixture export is `RULE_ATTACKS`, and each row declares `expectedFalseRuleIds`; the withdrawn
all-sixteen-exact-one `RULE_MUTATIONS` promise is not retained. Fifteen rows are exact-one. In
particular, `state.shared-read-write` removes only the reachable Window mutation while preserving
the shared authority and Stage mutation, and `state.reopen-wiring` changes only the unique
root-reachable close/reopen retained-state argument or independently named equivalent snapshot
callback. The authority-origin attack replaces the strong retained declaration with:

```kotlin
val sharedStore: BenchmarkStore get() = BenchmarkStore()
```

Its exact false vector is `state.single-source`, `state.shared-read-write`, and
`state.reopen-wiring`, with structural score 13. A top-level constructed strong
`val sharedStore = BenchmarkStore()` remains positive. The independently named equivalent fixture
must first score 16; mutating its reachable snapshot callback then flips only
`state.reopen-wiring`. Before fixture correction, the uncorrected checkpoint's exact subset-v1 RED
vector is false only for `plane.retry-readiness`, `state.shared-read-write`, and
`state.reopen-wiring`, with the other thirteen true and structural score 13.

### Downstream identity and restoration reservations

Task 7's preflight manifest must record `analyzerProtocolVersion`, `analyzerSubsetVersion`,
`analyzerDomainVersion`, `analyzerDomainSha256`, `analyzerSourceSha256`,
`analyzerBridgeSha256`, `analyzerJarSha256`, `analyzerClasspathSha256`,
`analyzerJdkTreeSha256`, and `analyzerReceiptSha256`, and must reserve
`kotlinInputSetSha256` and `selectedInputSetSha256` as required per-attempt fields. Every attempt
copies the exact static analyzer identities from preflight and supplies both source-set identities
for the immutable submission bytes it scored. The attempt values must join exactly to the validated
preflight receipt and those immutable bytes; a missing or mismatched field fails closed. Preflight
does not invent source-set digests for a submission that does not yet exist.

Task 8 must restore content-addressed, checksum-verified caches for all seven analyzer runtime
dependencies, the complete allowed JDK image, the complete pinned Gradle distribution, and the
populated fixture-Gradle seed before entering its deterministic no-network gate. The fixture seed
is verified against tracked `fixture-gradle-cache-v1.json`, copied into a fresh writable
`GRADLE_USER_HOME` with no init scripts, and used only with `--offline`. The analyzer must then run
`clean-build-twice` and `verify`, and the fixture helper must run its cache `verify`, before scorer
or compile tests. A cache miss or identity mismatch fails the gate; Task 8 may not consult ambient
Gradle/JDK/dependency state, resolve from the network inside the gate, or silently omit analyzer,
positive-aggregate, or compile tests.

Manifest metadata facts preserve their direct owner:

```ts
type ManifestMetadataFact = {
  scope: "application" | "activity";
  activityName: string | null;
  name: string;
  value: string | null;
  resource: string | null;
};

type ManifestFacts = {
  applicationName: string | null;
  activities: string[];
  metadata: ManifestMetadataFact[];
};
```

Only metadata immediately below `application` or `activity` is indexable. Application rows have a
null owner; activity rows carry the exact static, trimmed, non-empty `android:name` of their direct
activity parent. Metadata names and their one required `android:value` or `android:resource` are
static, trimmed, and non-empty. The identity is `(scope, activityName, name)`: identical duplicates
may collapse in the flattened aggregate while every parser span remains typed evidence, and a
conflicting declaration for one identity fails closed. Rows sort locale-independently over
`[scope, activityName || "", name, value || "", resource || ""]` and are deeply frozen.

`manifest.metadata` evidence repeats `scope` and `activityName` at top level and in the exact
five-field nested metadata object. The score contract requires those values to agree, requires the
nested name to equal the evidence value, forbids scope/owner/metadata fields on every other fact
kind, and retains no caller reference. Exact queries may include `scope` and `activityName`.
Normalized evidence order is:

```js
[
  evidenceClass,
  path,
  line,
  kind || "",
  scope || "",
  activityName || "",
  key || "",
  value || "",
  excerpt,
]
```

The shared trusted-JUnit contract exports
`TEST_EXECUTION_STREAM_MAX_BYTES = 4 * 1024 * 1024` (`4_194_304`). Receipt version 1 requires each
of `stdoutBytes` and `stderrBytes` independently in the inclusive range `0..4_194_304`. The Task 3
producer imports that same constant and counts raw bytes. On either overflow it terminates and
settles the child and pipes, returns no captured buffers, and mints no receipt; it never truncates,
hashes a prefix, converts overflow to `execution_failed`, or transfers unused capacity between
streams. At or below the limit it hashes only the complete captured streams, records their exact
lengths and digests, self-hashes the receipt, and validates it before return.

The compile fixture replaces, rather than supplements, the copied skeleton's default-Stage
metadata. Its launch activity owns `pico.spatial.windowcontainer.id` with value `BenchmarkWindow`,
`pico.spatial.windowcontainer.style` with planar value `1`, and
`pico.spatial.windowcontainer.defaultsize` with value `1280x720`; `mainApp` uses a
`DefaultWindowContainer` root. The secondary `Stage(...)` declaration has no style constructor
argument and needs no default-Stage metadata. Style is selected only on open:

```kotlin
navigator.openStage(
    SpatialContainers.ID_GALLERY,
    StageStyle.Mixed,
    bundle,
)
```

`spatial.container-topology` requires those exact activity-owned window facts plus the structural
secondary-Stage declaration and Mixed `openStage` path. Application-scoped bait or retained
default-Stage metadata cannot satisfy it. Its exact compile-valid isolation mutation is
`StageStyle.Mixed` to `StageStyle.Full`.

For `ecs.lifecycle`, the same System type/class is registered and unregistered in one paired
lifecycle scope. SDK 0.13.3 uses `registerSystem<OrbitSystem>()` and
`unregisterSystem<OrbitSystem>()`, not an object-instance parameter. The compile-valid isolation
mutation replaces `unregisterSystem<OrbitSystem>()` with `registerSystem<OrbitSystem>()`.

Finally, the trusted compile/JUnit launcher resolves and validates a JDK and Android SDK before
spawn and supplies explicit `JAVA_HOME`, `ANDROID_SDK_ROOT`, and `ANDROID_HOME` child values. It
uses the `scripts/sdk-facts.mjs` precedence: valid environment values first, Android Studio's
bundled JBR and platform SDK defaults second, and fail closed if either remains unresolved. This is
a compile precondition, not runtime or device evidence, and it does not authorize a wrapper or any
submission-controlled environment value.

## Frozen corpus revision

The `pico-spatial-agent-bench-v1` manifest contains these new binding fields:

```json
{
  "schemaVersion": 2,
  "corpusRevision": 2,
  "supersedes": {
    "identitySha256": "449ba40d15eb60d96b9a1572b6d2fecfc41f1072bee2846701c48895f47b7f70",
    "measuredAttempts": 0,
    "reason": "premeasurement_contract_correction"
  },
  "rubricVersion": 2,
  "resultSchemaVersion": 2,
  "runtimeProtocolVersion": 1,
  "protocolVectorsFile": "protocol-vectors.json",
  "workspaceMcp": {
    "serverName": "agentbench-workspace",
    "tools": ["workspace_list", "workspace_read", "workspace_write", "workspace_replace"]
  },
  "claudeClientBoundary": {
    "version": 1,
    "clientZone": "trusted_supervisor",
    "authentication": "max_oauth_keychain",
    "subprocessCredentialScrub": true
  }
}
```

`system-prompt.md`, `workspace-tools.json`, `pico-door-tools.json`, and
`protocol-vectors.json` are identity-bearing inputs. The workspace snapshot contains strict full
input/output schemas for four confined UTF-8 file capabilities. The PICO snapshot is the complete
provider-visible result of two independently matching local `tools/list` calls against the built
doors server; it retains descriptions, schemas, output schemas, and extension fields rather than
reducing the input to tool names.

The configured logical inventory is exact:

| Lane treatment | MCP servers | PICO access |
|---|---|---|
| bare | `agentbench-workspace` | pinned pico-cli through the later scanned/sandboxed Bash gateway |
| MCP | `agentbench-workspace`, `pico-spatial` | the frozen 18-door surface |

This inventory does not describe Claude built-ins. The later containment spike must prove the exact
logical provider tool set and block on any unexpected built-in or dynamically discovered tool.

## Structural rubric v2

The sixteen ordered definitions are:

```text
spatial.project-entry       spatialNative   source_and_typed_fact
spatial.container-topology spatialNative   source_and_typed_fact
spatial.entity-content     spatialNative   source
spatial.ui-lifecycle       spatialNative   source
ecs.component-clone        ecs             source
ecs.system-query           ecs             source
ecs.frame-update           ecs             source
ecs.lifecycle              ecs             source
state.single-source        statePassing    source
state.typed-handoff        statePassing    source
state.shared-read-write    statePassing    source
state.reopen-wiring        statePassing    source
plane.retry-readiness      planarTracking source
plane.semantic-fallback    planarTracking source
plane.anchor-pose          planarTracking source
plane.cleanup-errors       planarTracking source
```

A passing source rule has one or more source rows derived from a validated subset-v1 claim and its
reason begins `supported-subset-v1 witness:`. A passing mixed rule has at least one such source row
and one typed-fact row. Failed rules have no evidence. Evidence paths are normalized attempt-relative
POSIX paths; rows are bounded, unique, and sorted. Typed facts retain Task 2's parser-span-derived
path, line, excerpt, and typed fields. Each source row retains an internal validated PSI-node and
claim-witness digest until it joins the exact immutable `SourceIndex` bytes; every public row must
join back to `SourceIndex` or `findFactEvidence`. Schema validation alone does not establish
provenance, and neither a syntactically valid program nor a successful compile raises the
structural-only evidence ceiling.

The replacement state rule requires all of the following:

- the Stage open/create path receives the retained store or a typed snapshot derived from it;
- the Stage close path does not construct or assign a replacement benchmark store; and
- the reopen path reads selection, visit count, and pause state from the retained source.

Fixture seams are not production identifiers. Task 3 must accept an independently named repository
and typed reentry callback, and its isolated callback mutation must flip only this rule.

## Result schema v2

The exact normalized result shape is:

```ts
type ScoreResultV2 = {
  resultSchemaVersion: 2;
  rubricVersion: 2;
  rules: Array<{
    id: string;
    rubricVersion: 2;
    axis: "spatialNative" | "ecs" | "statePassing" | "planarTracking";
    evidenceClass: "source" | "source_and_typed_fact";
    pass: boolean;
    evidence: Array<SourceEvidence | TypedFactEvidence>;
    reason: string;
  }>;
  structuralAxes: {
    spatialNative: number;
    ecs: number;
    statePassing: number;
    planarTracking: number;
  };
  structuralScore: number;
  build: { status: "pass" | "fail" | "not_run"; receiptSha256: string | null };
  buildQualifiedStructuralScore: number;
  submissionTests: SubmissionTests;
  runtimeProtocolReceipts: RuntimeProtocolReceipts;
  visual: { status: "not_performed"; captureSha256: null };
};
```

`SubmissionTests` carries exact counts, fresh sorted result-file identities, the pre-build snapshot
hash, trusted execution-receipt hash, and its own canonical receipt digest. Passing requires a
nonzero all-pass result with no failures, errors, or skips. Failures, execution failure, no-source,
not-run, and build-failed-not-run are distinct states. Their status never changes a rubric rule or
score.

The trusted execution receipt binds the hash-pinned launcher and Gradle executable, exact offline
command, `submission` working directory, exit code, and complete bounded stdout/stderr hashes:

```text
$PINNED_GRADLE/bin/gradle --offline --no-daemon --no-configuration-cache
--console=plain :app:testDebugUnitTest
```

The later fresh-JUnit parser, not this amendment, establishes filesystem freshness and derives an
observed submission-test status.

## Ordered app-self-reported protocol

The application interface is a benchmark-only ordered broadcast action
`com.agentbench.<variant>.STATE`. Requests and responses are canonical UTF-8 JSON objects no larger
than 64 KiB, with no BOM, padding, or trailing newline. Requests contain protocol version 1, a
non-empty opaque request ID, a command, and an item only for `select`. Responses echo the version and
ID and contain status, nullable error code, and the complete reported state:

```ts
type ReportedStateV1 = {
  selection: string | null;
  title: string;
  visit_count: number;
  paused: boolean;
  stage_open: boolean;
  surface_status: "idle" | "searching" | "ready" | "no_surface" | "error";
  surface_semantic: "table" | "floor" | null;
  placement_count: number;
  tick_count: number;
  process_instance: string;
  stage_generation: number;
};
```

Every run first performs and receipts, in order: stop package, uninstall package, reset world, load
fixture, independently read back the fixture identity, install the receipt-bound APK, launch the
package, and wait for the receiver. No request precedes those steps, and no run reuses app data or
world state.

The exact four vectors are frozen as data:

- `state`: 17 requests against a separately reset `table-present` fixture. It covers fresh state,
  pause-before-Stage, a duplicate request ID, invalid fields, an unknown item, two selections, two
  close/reopen cycles, retained pause/state/title/visit count, monotonically reported Stage
  generation, and one stable process nonce.
- `tick`: 107 requests against another reset `table-present` fixture. It uses exactly two 50-snapshot
  running windows at 100 ms, a paused baseline and a second paused snapshot after 500 ms, then a
  resume. Counts must not decrease; only the app-reported counter is checked.
- `table_surface`: one selection plus exactly 60 snapshots at 250 ms against `table-present`.
- `floor_surface`: one selection plus exactly 60 snapshots at 250 ms against `floor-only`.

Each surface transcript contains searching before ready, then the matching semantic and exactly
three reported placements. These are app-self-reported fields. Receiver-driven close/open commands
do not prove an external Spatial container transition.

`RuntimeProtocolReceipts` can be `complete` only through a separate detailed receipt whose canonical
digest and private references all validate. It binds corpus, attempt, build, APK, package, vector,
environment, driver, validator, transcript, and four distinct reset/install receipt identities. The
attachment path resolves the guarded build receipt first and derives the authoritative APK/package;
then it resolves the ready environment and derives authoritative fixture identities; then it joins
each exact run-name reset/install receipt. Any transplant, missing private receipt, wrong digest,
wrong run name, or identity mismatch throws without changing the original score.

`blocked_environment` requires a self-hashed typed blocked environment receipt and may not carry
protocol, APK, fixture-run, or transcript identities. Not-run records contain no identities. Task 3
creates only not-run defaults; it cannot manufacture complete or blocked evidence.

## Gates that remain closed

- Live Claude smoke and cohort execution remain `blocked_confidentiality` until PICO supplies a
  private written receipt approving Anthropic and each egress class plus an operative denylist. The
  pinned-client containment and fake-provider composition must also pass end to end.
- The runtime protocol remains `blocked_environment` without a compatible running emulator,
  fresh-state strategy, and hashed table/floor fixtures. A pass is never synthesized.
- Behavior is unavailable. Instrumentation success is not external observation.
- Visual status remains `not_performed` unless the exact linked capture is opened and inspected
  under `AGENTS.md`. This amendment produced no capture and makes no visual claim.
- Claude Max is the only authorized entitlement. No metered API key or paid fallback is permitted.
- No Windows, Swan-hardware, device, SDK-6.x compatibility, passthrough-frame, or XR-motion claim is
  earned here. The separately owned Windows lane remains untouched.
- Publication and export remain disabled. Repository visibility and permissions are unchanged, and
  no quarantine or measured artifact belongs in Git.
