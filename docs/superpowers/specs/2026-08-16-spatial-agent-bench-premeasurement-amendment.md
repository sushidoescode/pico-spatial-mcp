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

A passing source rule has one or more source rows. A passing mixed rule has at least one source row
and one typed-fact row. Failed rules have no evidence. Evidence paths are normalized attempt-relative
POSIX paths; rows are bounded, unique, and sorted. Typed facts retain Task 2's parser-span-derived
path, line, excerpt, and typed fields. The scorer must join every row back to `SourceIndex` or
`findFactEvidence`; schema validation alone does not establish provenance.

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
