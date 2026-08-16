# SpatialAgentBench Design

**Date:** 2026-08-15

**Status:** Approved in conversation

**Scope:** A reproducible agent-generation benchmark for PICO Spatial SDK applications

## Decision

Build `SpatialAgentBench` as a sibling to the existing `run_spatialbench` evaluator. The existing
benchmark evaluates pre-authored AppSpecs produced by this repository; it must not be extended to
imply that it measures open-ended agent behavior.

The first measured cohort compares:

1. Claude Sonnet 5 using the pico-spatial MCP `doors` surface.
2. Claude Opus 5 using bare `@picoxr/pico-cli@0.4.2` with no MCP servers.

Sonnet with bare pico-cli and Opus with MCP are control lanes. All four lanes use Spatial SDK
0.13.3 in the primary cohort so the treatment is MCP access rather than SDK-version drift.

Live benchmark measurement begins only after the separately owned trust-ledger provenance P0 has
landed and been verified. Harness and fixture development may proceed before that dependency, but
no live result may be presented as trusted evidence without it.

## Purpose

The benchmark converts four reported agent failure modes into reproducible scored axes:

- falling back to Android-style application structure instead of Spatial SDK primitives;
- poor ECS design and lifecycle handling;
- incorrect state passing between spatial containers;
- incorrect or brittle planar tracking.

Its primary hypothesis is that Sonnet with pico-spatial MCP can outperform Opus with bare pico-cli.
The benchmark reports the measured result even when that hypothesis fails.

## Non-goals

This design does not:

- change the existing SpatialBench league or its frozen core;
- compare SDK 0.13.3 results directly with SDK 6.0 results;
- treat generated log text as proof of behavior;
- claim Swan-device or Windows behavior from the macOS emulator lane;
- score visual quality without a person or vision-capable agent looking at a rendered capture;
- publish raw prompts, transcripts, generated projects, emulator logs, or captures;
- reproduce dynamic Spatial Editor tools or first-party editor authoring behavior.

## Architecture

SpatialAgentBench has four components with narrow interfaces.

### 1. Frozen corpus manifest

The versioned corpus defines:

- rubric and corpus version;
- five task variants;
- exact shared prompt template and per-variant values;
- required SDK and pico-cli versions;
- lane definitions and canonical model IDs;
- randomization seed;
- timeout and usage limits;
- hashes of every frozen input.

The manifest is data, not executable orchestration. Changing it creates a new corpus version and
prevents accidental comparison with earlier results.

### 2. Serial runner

The runner is a repository CLI, not an MCP tool. It:

1. requires an explicit absolute run root outside the repository;
2. verifies the selected Claude model, Claude CLI, SDK, pico-cli package integrity, repository
   commit, built MCP hash, and trust-ledger readiness;
3. verifies infrastructure by building a fixed reference project;
4. creates a new scratch workspace for each run;
5. supplies either a strict `doors` MCP configuration or a strict empty MCP configuration;
6. invokes Claude CLI non-interactively with no human repair turn;
7. runs paired lanes serially in seeded randomized order;
8. builds and tests the delivered project;
9. records artifacts, hashes, timings, usage, tool calls, and exit reason;
10. checkpoints only between matched pairs.

Gradle and emulator work is serial because those resources have shared mutable state. Both members
of every matched pair must use the same blinded Max-account block; otherwise the pair does not
start. The second Max account is quota fallback and is not permanently assigned to a treatment.
Account identity is never part of a public report.

### 3. Deterministic scorer

The scorer is a pure, versioned module. It receives a generated-project path plus build and runtime
receipts and returns machine-readable rule evidence. It does not read the user trust ledger,
network, emulator, or mutable repository state.

Each rule emits:

- rule identifier and rubric version;
- pass or fail;
- file and line when applicable;
- a short excerpt or structured runtime receipt;
- a human-readable reason.

Source matching strips comments and string literals before structural checks. A rule never awards
credit for benchmark vocabulary, comments, or self-authored success logs alone.

### 4. Reporter

The reporter aggregates immutable per-run score documents. It produces a private full report and,
only after an explicit confidentiality gate, a sanitized projection suitable for tracking or
sharing. The reporter never alters raw artifacts.

## Corpus

All five variants use the same required behavior and differ only in nouns, labels, and values:

1. museum objects: vase, astrolabe, mask;
2. planets: Mercury, Venus, Mars;
3. instruments: cello, synthesizer, drum;
4. botanical specimens: fern, orchid, cactus;
5. exploration vehicles: rover, drone, submersible.

The user-facing prompt requests a buildable PICO Spatial SDK 0.13.3 application that:

- begins in a planar spatial window with three selectable items;
- opens a Mixed Stage for the selected item;
- preserves selection, title, visit count, and pause state across Stage close and reopen;
- places three spatial entities on a detected horizontal table, with a floor fallback;
- animates the entities through engine-driven per-frame behavior;
- remains usable while searching and when no suitable surface exists;
- exposes a benchmark-only broadcast hook for state, plane, placement, and tick receipts.

The prompt describes these behaviors without naming ECS, `Bundle`, `PlaneTrackingManager`, or the
specific APIs used by the rubric. The broadcast hook enables repeatable runtime driving but cannot
earn a point without corroborating source structure.

## Scoring

Each axis has four one-point conditions. The structural total is 0–16.

| Axis | One-point conditions |
|---|---|
| Spatial-native architecture | PICO BOM/plugin, manifest, and `mainApp` entry; requested WindowContainer and Mixed Stage topology through spatial navigation; Stage content uses SpatialView and PICO entities/components/resources rather than Activity/View/Canvas/OpenGL substitutes; planar content uses PICO SpatialUI/PicoTheme with correct container lifecycle. |
| ECS correctness | A state-bearing Component has a default constructor and state-preserving clone; a custom System uses a hoisted component query and `update(SceneUpdateContext)`; per-frame work uses `deltaTime`, queries `context.scene`, and mutates the existing TransformComponent; system registration and unregistration are paired with lifecycle disposal. |
| State passing | One source of truth survives container replacement; immutable launch arguments use a typed Bundle/route handoff or an explicit equivalent; Window and Stage read and update the same shared state without independent `remember` copies; an executable test or runtime probe round-trips two selections and a retained counter. |
| Planar tracking | Tracking is started and anchor loading retries instead of treating RUNNING as readiness; a horizontal TABLE is selected with a FLOOR fallback using semantic and geometry checks; placement derives converted pose and height from the selected anchor rather than a fixed Y value; tracking/subscriptions stop cleanly and empty/error paths remain usable. |

The delivery-qualified primary score is:

```text
deliveryScore = buildPass ? structuralScore : 0
```

The uncapped structural score remains in every result so a build failure does not erase diagnostic
information. `runtimeStatePass`, `runtimePlanePass`, and `runtimeEcsPass` are reported separately.
Visual evidence is also separate and may be `not_performed`, `auto_judged`, or `vision_verified`;
`vision_verified` requires a linked capture that was actually inspected.

## Lanes and run count

The four lanes are:

| Lane | Model | Tool treatment | Role |
|---|---|---|---|
| `sonnet_mcp` | canonical Claude Sonnet 5 | pico-spatial MCP, `doors` | primary treatment |
| `opus_bare` | canonical Claude Opus 5 | pinned pico-cli, no MCP | primary comparator |
| `sonnet_bare` | canonical Claude Sonnet 5 | pinned pico-cli, no MCP | weak-model/control estimate |
| `opus_mcp` | canonical Claude Opus 5 | pico-spatial MCP, `doors` | model-ceiling/control estimate |

Run one excluded smoke for each lane, all five paired variants for the two primary lanes, and
variants 1, 3, and 5 once in each control lane. A later sign-off cohort runs each of the five
primary variants in two separately randomized account blocks, producing ten pairs without changing
the prompt, rubric, runner, or scorer.

Claude Max entitlement is used; no metered API spend is authorized. Elapsed time, subscription
usage, and any nominal cost estimate printed by the CLI are recorded separately. Quota exhaustion
pauses the cohort between pairs and never causes model substitution.

## Failure semantics

A timeout, refusal, wrong canonical model, missing deliverable, or model-caused tool failure is a
treatment failure and receives delivery score zero. Partial source is still scored structurally.

A run is `NA` only when the fixed reference project independently demonstrates the same
infrastructure failure immediately after the incident and under the same environment. After the
infrastructure is restored, rerun the entire matched pair. Do not selectively rerun a low-scoring
model outcome.

The runner refuses to start a measured run when:

- the run root resolves inside the repository;
- the trust-ledger provenance gate is unavailable or failing;
- the expected model or tool configuration cannot be proven;
- frozen input hashes differ;
- the reference project does not build.

Unexpected termination leaves an append-only run manifest marked incomplete. Resume begins with a
new run identifier; it never overwrites or completes the interrupted record in place.

## Validation strategy

Before any live model run, deterministic tests prove the scorer and runner boundaries:

- a complete fixture scores 16/16;
- an Android-style fixture loses all Spatial-native points;
- one mutation fixture per rule changes exactly that rule's point;
- adversarial fixtures place rubric terms only in comments, strings, and fake logs;
- a compiler failure forces delivery score zero while preserving structural diagnostics;
- runner simulations cover timeout, refusal, wrong-model metadata, incomplete output, and
  independently verified infrastructure failure;
- two identical scorer invocations produce byte-identical normalized score documents;
- private run artifacts cannot be written into the repository;
- sanitized export fails closed when prohibited strings or unapproved raw fields are present.

Existing `test:conformance` may supply version-scoped rule knowledge, but SpatialAgentBench tests do
not call user lessons, mutable trust ledgers, network services, or the emulator.

## Evidence and confidentiality

Each run records hashes for:

- prompt, corpus, rubric, and randomization seed;
- repository commit and built MCP entry point;
- SDK installation and pico-cli package integrity;
- MCP configuration;
- generated submission and build log;
- score document and runtime evidence.

It also records canonical model ID, Claude CLI version, blinded account block, start/end time,
duration, tool calls, usage, exit reason, build status, and scorer version.

The generic canonical prompt template, corpus, rubric, and synthetic fixtures may be tracked in
this private repository because they contain no emulator-derived identifiers. The exact composed
model input, transcripts, generated projects, logs, and captures remain in the explicit
out-of-repository run root. No measured-result artifact is published or added to tracked
documentation until PICO provides written confidentiality guidance and a denylist. Until then,
sanitized export is disabled. Once enabled, it preserves hashes and numerical results while
rejecting prohibited identifiers and raw diagnostic payloads. Repository visibility and
permissions are never changed by this workflow.

## Aggregation and claim bar

Reports include every run and every point, including zeros, plus:

- mean, median, and range of delivery and structural scores;
- per-axis means and build/runtime pass rates;
- paired primary-lane differences;
- a seeded 10,000-resample paired bootstrap 95% confidence interval;
- duration, usage, timeout, permission, model, and infrastructure outcomes.

Five pairs are explicitly preliminary. A PICO sign-off candidate requires all of the following on
the frozen ten-pair cohort:

1. the lower bound of the paired 95% bootstrap interval for Sonnet+MCP minus Opus+bare is above
   zero;
2. Sonnet+MCP build-pass rate is not lower than Opus+bare;
3. no Sonnet+MCP axis mean is more than 0.5 points below the corresponding Opus+bare mean;
4. all failures and exclusions are reported with their predeclared semantics.

Failing any condition is a measured negative or inconclusive result, not a reason to revise the
rubric or hide the cohort.

## Implementation boundary

The implementation may add:

- a versioned pure scorer module separate from `src/spatialbench.ts`;
- corpus and rubric data under a dedicated benchmark directory;
- a repository CLI for orchestration;
- deterministic scorer and runner tests;
- package scripts for fixture validation and explicitly initiated live runs.

It must not add recursive model execution to the MCP tool surface, change existing SpatialBench
membership, alter the trust-ledger implementation owned by the other session, or commit live raw
artifacts.

## Delivery sequence

1. Verify and consume the trust-ledger provenance P0 from its owning session.
2. Implement and fixture-test the harness without changing MCP behavior.
3. Freeze and hash the pre-remediation inputs.
4. Run and report the preliminary pre-remediation cohort.
5. Use the benchmark and upstream audit to write the broader remediation plan.
6. Implement prioritized correctness and upstream-alignment fixes.
7. Optionally repeat the identical cohort as post-remediation evidence.
