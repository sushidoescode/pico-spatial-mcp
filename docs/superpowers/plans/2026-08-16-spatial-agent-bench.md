# SpatialAgentBench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run a reproducible benchmark that measures whether Claude Sonnet 5 with the pico-spatial MCP outperforms Claude Opus 5 with bare pico-cli on Spatial SDK architecture, ECS, state passing, and planar tracking.

**Architecture:** Keep the benchmark under `benchmarks/spatial-agent-bench/`, outside the MCP tool surface and npm package. A frozen data corpus feeds a deterministic source scorer and serial Claude CLI runner. The runner reuses the P0 lane's canonical identity and guarded Gradle-input primitives to seal an arbitrary-submission build receipt; it does not fabricate the fleet receipt's AppSpec lineage. An append-only external store retains raw attempts, and a pure reporter computes paired statistics.

**Tech Stack:** Node.js 20/22 ESM, `node:test`, Zod 3, Claude Code 2.1.233 with Claude Max authentication, `@picoxr/pico-cli@0.4.2`, Spatial SDK 0.13.3, Gradle, and the landed digest-bound provenance primitives.

## Global Constraints

- `sushidoescode/pico-spatial-mcp` remains PRIVATE; never change visibility, collaborators, or permissions.
- Create a new worktree/branch from the clean `pico-evolution-2026-08-14` commit containing the immutable-ledger and native-run-receipt P0. Never edit that protected worktree or the Windows lane.
- Before live model runs, `npm run test:ledger` must report zero failures and `npm run test:runreceipt` must report at least the independently observed 208 passing tests with no failures on the exact benchmark checkout.
- The primary cohort pins Spatial SDK `0.13.3`, pico-cli `0.4.2`, Claude Code `2.1.233`, effort `high`, and a 30-minute process timeout in every lane.
- Claude Max is the only model entitlement. Do not configure an API key, fallback model, or metered spend. CLI dollar fields are nominal usage metadata, not incremental cash cost.
- Raw composed prompts, stream events, generated projects, build logs, captures, account identifiers, and private reports live under an explicit absolute run root outside every Git worktree.
- The tracked corpus and synthetic fixtures contain no emulator-derived confidential identifiers. Measured-result export stays disabled until PICO supplies written guidance and a denylist.
- A timeout, refusal, wrong model, missing submission, or model-caused tool failure is a treatment failure. An `NA` requires the fixed reference app to reproduce the same infrastructure failure immediately after the incident.
- Visual quality is outside the 0–16 score. Never call a capture visually verified without opening and inspecting that exact image.
- macOS evidence is emulator-only. Do not infer Swan-hardware or Windows behavior.
- Five primary pairs are preliminary. A sign-off cohort requires ten frozen pairs, a positive paired 95% bootstrap interval, no lower MCP build-pass rate, and no MCP axis mean more than 0.5 points below its comparator.
- The harness and preliminary cohort come before behavioral remediation, preserving an honest pre-remediation baseline.
- Target the harness and preliminary report before the August 31 curriculum deadline; editor wrapping and v1.0 CLI alignment remain separately sequenced for the end-of-September landing.

---

## File Map

| File | Responsibility |
|---|---|
| `benchmarks/spatial-agent-bench/v1/corpus.json` | Frozen versions, lane definitions, variants, limits, and seed. |
| `benchmarks/spatial-agent-bench/v1/prompt.md` | One treatment-neutral prompt template. |
| `benchmarks/spatial-agent-bench/lib/identity.mjs` | Thin reuse boundary over digest-bound canonical JSON/identity. |
| `benchmarks/spatial-agent-bench/lib/corpus.mjs` | Strict corpus loading, hashing, prompt rendering, and seeded schedules. |
| `benchmarks/spatial-agent-bench/lib/source.mjs` | Bounded, symlink-safe source inventory and structural masking. |
| `benchmarks/spatial-agent-bench/lib/rules-spatial.mjs` | Spatial-native and ECS rules. |
| `benchmarks/spatial-agent-bench/lib/rules-behavior.mjs` | State-passing and planar-tracking rules. |
| `benchmarks/spatial-agent-bench/lib/score.mjs` | Rule composition, build gating, and normalized scores. |
| `benchmarks/spatial-agent-bench/lib/process.mjs` | Claude auth, invocation isolation, bounded process tree, stream parser. |
| `benchmarks/spatial-agent-bench/lib/build-receipt.mjs` | Guarded arbitrary-Gradle build and immutable APK/source receipt. |
| `benchmarks/spatial-agent-bench/lib/store.mjs` | External-root guard and create-only attempt/artifact manifests. |
| `benchmarks/spatial-agent-bench/lib/report.mjs` | Cohort aggregation, paired bootstrap, and claim classification. |
| `benchmarks/spatial-agent-bench/lib/runner.mjs` | Preflight, pinned toolchain, scratch workspace, scoring, checkpointing. |
| `benchmarks/spatial-agent-bench/run.mjs` | Human-invoked `prepare`, `smoke`, `run`, `report`, and gated `export`. |
| `test/helpers/agentbench-fixture.mjs` | Synthetic complete project plus one mutation per rubric point. |
| `test/agentbench-*.mjs` | Deterministic corpus, source, score, process, receipt, store, and runner gates. |
| `docs/SPATIAL_AGENT_BENCH.md` | Reproduction and evidence boundaries without measured results. |

---

### Task 1: Frozen Corpus, Prompt, and Schedule

**Files:**
- Create: `benchmarks/spatial-agent-bench/v1/corpus.json`
- Create: `benchmarks/spatial-agent-bench/v1/prompt.md`
- Create: `benchmarks/spatial-agent-bench/lib/identity.mjs`
- Create: `benchmarks/spatial-agent-bench/lib/corpus.mjs`
- Create: `test/agentbench-corpus.mjs`

**Interfaces:**
- Consumes: `canonicalJson(value)` and `canonicalIdentity(value)` from `dist/runreceiptidentity.js` after `npm run build`.
- Produces: `loadCorpus(corpusDir)`, `renderPrompt(loaded, variantId, laneId)`, `createPreliminarySchedule(loaded)`, and `createSignoffSchedule(loaded)`.

- [ ] **Step 1: Write the failing corpus contract test**

Create `test/agentbench-corpus.mjs` with literal assertions:

```js
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createPreliminarySchedule,
  createSignoffSchedule,
  loadCorpus,
  renderPrompt,
} from "../benchmarks/spatial-agent-bench/lib/corpus.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusDir = path.join(root, "benchmarks", "spatial-agent-bench", "v1");

test("v1 corpus freezes the fair four-lane comparison", () => {
  const loaded = loadCorpus(corpusDir);
  assert.equal(loaded.corpus.sdkVersion, "0.13.3");
  assert.equal(loaded.corpus.picoCli.version, "0.4.2");
  assert.equal(loaded.corpus.picoCli.integrity, "sha512-qapgwB+OljD0qQukilhaAmhIemuoIvMO/dkQOVDcZEhLdW1KxpbpkNyLII9hJ6m5F/QYF4UZoPpkjH9IL5U7mA==");
  assert.equal(loaded.corpus.claudeCliVersion, "2.1.233");
  assert.equal(loaded.corpus.claudeCliSha256, "bc466b6cde63edafc773f471a1fb98787fabb31f52240c8616ce7e1f587b212d");
  assert.equal(loaded.corpus.timeoutMs, 1_800_000);
  assert.equal(loaded.corpus.maxTurns, 100);
  assert.equal(loaded.corpus.seed, 20_260_816);
  assert.deepEqual(loaded.corpus.lanes.map(({ id, model, treatment }) => ({ id, model, treatment })), [
    { id: "sonnet_mcp", model: "claude-sonnet-5", treatment: "mcp" },
    { id: "opus_bare", model: "claude-opus-5", treatment: "bare" },
    { id: "sonnet_bare", model: "claude-sonnet-5", treatment: "bare" },
    { id: "opus_mcp", model: "claude-opus-5", treatment: "mcp" },
  ]);
  assert.deepEqual(loaded.corpus.variants.map((variant) => variant.id), [
    "museum", "planets", "instruments", "botanical", "vehicles",
  ]);
  assert.match(loaded.identity.sha256, /^[a-f0-9]{64}$/);
});

test("preliminary order is seeded, paired, and controls are predeclared", () => {
  const schedule = createPreliminarySchedule(loadCorpus(corpusDir));
  assert.deepEqual(schedule.primary.map(({ variantId, lanes }) => [variantId, lanes]), [
    ["museum", ["sonnet_mcp", "opus_bare"]],
    ["botanical", ["opus_bare", "sonnet_mcp"]],
    ["planets", ["sonnet_mcp", "opus_bare"]],
    ["instruments", ["sonnet_mcp", "opus_bare"]],
    ["vehicles", ["sonnet_mcp", "opus_bare"]],
  ]);
  assert.deepEqual(schedule.controls.map(({ variantId, laneId }) => `${variantId}:${laneId}`), [
    "museum:sonnet_bare", "vehicles:sonnet_bare", "vehicles:opus_mcp",
    "museum:opus_mcp", "instruments:sonnet_bare", "instruments:opus_mcp",
  ]);
  assert.equal(createSignoffSchedule(loadCorpus(corpusDir)).primary.length, 10);
});

test("the shared prompt fixes behavior without teaching rubric APIs", () => {
  const prompt = renderPrompt(loadCorpus(corpusDir), "museum", "sonnet_mcp");
  for (const required of ["submission/", "0.13.3", "vase", "astrolabe", "mask", "Mixed Stage", "table", "floor", "visit count"]) {
    assert.match(prompt, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  for (const leaked of ["EntityQueryCondition", "SceneUpdateContext", "Bundle", "PlaneTrackingManager", "deltaTime"]) {
    assert.equal(prompt.includes(leaked), false, leaked);
  }
});
```

- [ ] **Step 2: Run the focused test and observe RED**

```bash
npm run build
node --test test/agentbench-corpus.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/corpus.mjs`.

- [ ] **Step 3: Add the frozen data contract**

Create `corpus.json` with this exact shape and values:

```json
{
  "schemaVersion": 1,
  "corpusId": "pico-spatial-agent-bench-v1",
  "rubricVersion": 1,
  "sdkVersion": "0.13.3",
  "picoCli": {
    "package": "@picoxr/pico-cli",
    "version": "0.4.2",
    "integrity": "sha512-qapgwB+OljD0qQukilhaAmhIemuoIvMO/dkQOVDcZEhLdW1KxpbpkNyLII9hJ6m5F/QYF4UZoPpkjH9IL5U7mA=="
  },
  "claudeCliVersion": "2.1.233",
  "claudeCliCommit": "f8d57569aaf3",
  "claudeCliSha256": "bc466b6cde63edafc773f471a1fb98787fabb31f52240c8616ce7e1f587b212d",
  "effort": "high",
  "timeoutMs": 1800000,
  "maxTurns": 100,
  "maxOutputBytes": 67108864,
  "seed": 20260816,
  "controlVariantIds": ["museum", "instruments", "vehicles"],
  "lanes": [
    { "id": "sonnet_mcp", "model": "claude-sonnet-5", "treatment": "mcp", "role": "primary" },
    { "id": "opus_bare", "model": "claude-opus-5", "treatment": "bare", "role": "primary" },
    { "id": "sonnet_bare", "model": "claude-sonnet-5", "treatment": "bare", "role": "control" },
    { "id": "opus_mcp", "model": "claude-opus-5", "treatment": "mcp", "role": "control" }
  ],
  "variants": [
    { "id": "museum", "title": "Museum Objects", "items": ["vase", "astrolabe", "mask"] },
    { "id": "planets", "title": "Planet Gallery", "items": ["Mercury", "Venus", "Mars"] },
    { "id": "instruments", "title": "Instrument Gallery", "items": ["cello", "synthesizer", "drum"] },
    { "id": "botanical", "title": "Botanical Specimens", "items": ["fern", "orchid", "cactus"] },
    { "id": "vehicles", "title": "Exploration Vehicles", "items": ["rover", "drone", "submersible"] }
  ]
}
```

Create `prompt.md` with these exact bytes apart from the final newline:

```text
Build a complete PICO Spatial SDK 0.13.3 application for the {{VARIANT_TITLE}} scenario.

Work only inside a new submission/ directory. Use package com.agentbench.{{VARIANT_ID}}.{{LANE_ID}}.
Deliver the full Gradle project, source, manifest, resources, and executable tests; do not return only
an explanation or snippets.

The app starts in a planar spatial window showing three selectable items: {{ITEM_1}}, {{ITEM_2}}, and
{{ITEM_3}}. Show the current title, selected item, visit count, and paused/running state. Selecting an
item opens a Mixed Stage for it. Closing and reopening the Stage must preserve selection, title,
visit count, and pause state, and both containers must be able to update that same state.

In the Stage, place three spatial entities on a detected horizontal table. If no suitable table is
available, use a suitable horizontal floor. Surface readiness may lag tracking startup, so keep the
app responsive while searching and retry for a bounded period. Derive placement from the selected
surface pose and geometry. Show useful searching, no-surface, and error states. Release tracking,
subscriptions, and per-frame work when their owning lifecycle ends.

Animate the placed entities through engine-driven per-frame behavior. The pause control must stop and
resume that motion without losing the current selection or visit count.

For repeatable tests, expose a benchmark-only broadcast action
com.agentbench.{{VARIANT_ID}}.STATE whose response reports selection, title, visit_count, paused,
surface_status, surface_semantic, placement_count, and tick_count. Add executable tests that select
two different items, close and reopen the Stage, and prove the retained visit count and pause state.

Before finishing, run the strongest local build and unit-test commands available. Leave every
deliverable under submission/ and summarize the attempted commands and any remaining failure honestly.
```

The renderer substitutes all six named template tokens, including the lane-specific package suffix,
before the prompt is hashed. The file must not name the five prohibited rubric API terms or any
treatment-specific tool.

- [ ] **Step 4: Implement strict loading and schedules**

`identity.mjs` contains only:

```js
export { canonicalIdentity, canonicalJson } from "../../../dist/runreceiptidentity.js";
```

`corpus.mjs` exports:

```js
export function loadCorpus(corpusDir) {}
export function renderPrompt(loaded, variantId, laneId) {}
export function createPreliminarySchedule(loaded) {}
export function createSignoffSchedule(loaded) {}
```

Use a SHA-256 counter stream and Fisher-Yates. For counter `n`, hash
`String(seed) + "\\0" + label + "\\0" + String(n)`, read the first unsigned big-endian 32-bit
integer, and divide by `2 ** 32`. Use independent labels `preliminary-primary-order`,
`preliminary-primary-lanes`, `preliminary-controls`, and `signoff-primary`; the literal schedule in
Step 1 is the cross-platform test vector. Reject duplicate IDs, unknown keys, version drift,
undeclared prompt tokens, or unreplaced template tokens. Hash the parsed corpus plus exact prompt
bytes through `canonicalIdentity`.

- [ ] **Step 5: Run the corpus gate and observe GREEN**

```bash
npm run build
node --test test/agentbench-corpus.mjs
```

Expected: 3 tests pass.

- [ ] **Step 6: Commit the corpus**

```bash
git add benchmarks/spatial-agent-bench/v1 benchmarks/spatial-agent-bench/lib/identity.mjs benchmarks/spatial-agent-bench/lib/corpus.mjs test/agentbench-corpus.mjs
git commit -m "test(bench): freeze agent comparison corpus"
```

---

### Task 2: Safe Source Inventory and Structural Masking

**Files:**
- Create: `benchmarks/spatial-agent-bench/lib/source.mjs`
- Create: `test/agentbench-source.mjs`

**Interfaces:**
- Consumes: an absolute generated-project directory.
- Produces: `loadSubmissionSources(projectDir)` and `findEvidence(index, matcher, options)`.

- [ ] **Step 1: Write failing masking and containment tests**

Assert a stable sorted inventory; nested Kotlin block comments plus line comments, character
literals, escaped strings, and triple-quoted raw-string masking; XML and TOML comment masking;
preserved newline counts; and rejections for an escaping symlink, more than 2,000 selected files, a
file above 2 MiB, or more than 32 MiB selected in total.

```js
const index = loadSubmissionSources(projectDir);
assert.deepEqual(index.files.map((file) => file.path), [
  "app/src/main/AndroidManifest.xml",
  "app/src/main/java/com/agentbench/Foo.kt",
  "gradle/libs.versions.toml",
]);
assert.equal(index.files[1].structural.includes("PlaneTrackingManager.start()"), true);
assert.equal(index.files[1].structural.includes("fake in comment"), false);
assert.equal(index.files[1].structural.split("\n").length, index.files[1].original.split("\n").length);
assert.throws(() => loadSubmissionSources(symlinkEscapeProject), /symlink|escape/i);
```

- [ ] **Step 2: Run the test and observe RED**

```bash
node --test test/agentbench-source.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/source.mjs`.

- [ ] **Step 3: Implement the bounded source index**

Export:

```js
/** @typedef {{path:string, absolutePath:string, kind:"kotlin"|"gradle"|"manifest", original:string, structural:string}} SourceFile */
/** @typedef {{projectDir:string, files:SourceFile[], totalBytes:number}} SourceIndex */
export function loadSubmissionSources(projectDir) {}
export function findEvidence(index, matcher, { paths, original = false } = {}) {}
```

Select only Kotlin, Gradle, TOML, and Android manifest inputs. Skip `.gradle`, `build`, `.git`, and
cache directories. Use `lstat`, `realpath`, and `path.relative`; reject all symlinks. Replace masked
non-newline bytes with spaces so excerpts retain original line numbers.

- [ ] **Step 4: Run the source gate and observe GREEN**

```bash
node --test test/agentbench-source.mjs
```

Expected: all masking, bound, and escape tests pass.

- [ ] **Step 5: Commit the source boundary**

```bash
git add benchmarks/spatial-agent-bench/lib/source.mjs test/agentbench-source.mjs
git commit -m "feat(bench): index submissions without token stuffing"
```

---

### Task 3: Versioned 16-Point Scorer

**Files:**
- Create: `benchmarks/spatial-agent-bench/lib/rules-spatial.mjs`
- Create: `benchmarks/spatial-agent-bench/lib/rules-behavior.mjs`
- Create: `benchmarks/spatial-agent-bench/lib/score.mjs`
- Create: `test/helpers/agentbench-fixture.mjs`
- Create: `test/agentbench-score.mjs`

**Interfaces:**
- Consumes: `SourceIndex`, build evidence, and optional runtime receipts.
- Produces: `scoreSubmission({ projectDir, build, runtime })` with rubric v1 evidence, structural score, and delivery score.

The return object is strict and contains:

```js
{
  rubricVersion: 1,
  rules,
  axes: { spatialNative, ecs, statePassing, planarTracking },
  structuralScore,
  buildPass,
  deliveryScore,
  runtime: { statePass, planePass, ecsPass },
  visual: { status: "not_performed", captureSha256: null },
}
```

Each axis is an integer from 0–4; totals are integers from 0–16. Runtime and visual fields never
change the structural or delivery score in rubric v1.

- [ ] **Step 1: Write failing perfect/mutation tests**

Use these literal rule IDs:

```js
const RULE_IDS = [
  "spatial.project-entry", "spatial.container-topology", "spatial.entity-content", "spatial.ui-lifecycle",
  "ecs.component-clone", "ecs.system-query", "ecs.frame-update", "ecs.lifecycle",
  "state.single-source", "state.typed-handoff", "state.shared-read-write", "state.round-trip",
  "plane.retry-readiness", "plane.semantic-fallback", "plane.anchor-pose", "plane.cleanup-errors",
];

const perfect = scoreSubmission({ projectDir: writeCompleteProject(t), build: passingBuild });
assert.equal(perfect.structuralScore, 16);
assert.equal(perfect.deliveryScore, 16);
assert.deepEqual(perfect.rules.map((rule) => rule.id), RULE_IDS);

for (const mutation of RULE_MUTATIONS) {
  const scored = scoreSubmission({ projectDir: writeCompleteProject(t, mutation.apply), build: passingBuild });
  assert.deepEqual(scored.rules.filter((rule) => !rule.pass).map((rule) => rule.id), [mutation.ruleId]);
  assert.equal(scored.structuralScore, 15);
}
```

Also assert an Activity/View/Canvas substitute loses all Spatial-native points; terms only in
comments, strings, or fake logs earn nothing; and a failed build preserves structural diagnostics
while forcing delivery score zero.

- [ ] **Step 2: Run the score test and observe RED**

```bash
node --test test/agentbench-score.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/score.mjs`.

- [ ] **Step 3: Implement Spatial-native and ECS rules**

Every rule returns exactly:

```js
{
  id: "ecs.frame-update",
  axis: "ecs",
  pass: true,
  evidence: [{
    path: "app/src/main/java/com/agentbench/museum/OrbitSystem.kt",
    line: 18,
    excerpt: "transform.rotation = transform.rotation * Quaternion.axisAngle(Vector3.Up, context.deltaTime)",
  }],
  reason: "per-frame code uses update context timing and mutates the existing transform",
}
```

Award the first eight points only for the approved conjunctions: 0.13.3 spatial project and one
`mainApp`; planar WindowContainer plus declared/opened Mixed Stage; SpatialView/PICO entities rather
than Android substitutes; SpatialUI/PicoTheme lifecycle; defaultable state-bearing Component with
state-preserving clone; custom System with hoisted query against `context.scene`; delta-time-based
in-place transform mutation; paired register/unregister in one lifecycle scope.

- [ ] **Step 4: Implement state and plane rules**

Award the remaining points only for: one shared store; typed launch handoff; both containers reading
and mutating the same state without independent benchmark-state `remember` copies; an executable
two-selection retained-counter round trip; tracking start plus bounded anchor retries; horizontal
TABLE selection with FLOOR fallback and geometry checks; converted anchor-derived placement rather
than fixed Y; and paired stop/unsubscribe plus explicit searching/empty/error paths.

Keep these rules explicitly 0.13.3-scoped. Do not import current-v6 provenance claims invalidated by
the upstream audit.

- [ ] **Step 5: Build the complete fixture and sixteen isolated mutations**

`test/helpers/agentbench-fixture.mjs` exports:

```js
export function writeCompleteProject(t, mutate = (files) => files) {}
export const RULE_MUTATIONS = [
  { ruleId: "spatial.project-entry", apply: replace("fun mainApp", "fun notMainApp") },
  { ruleId: "spatial.container-topology", apply: replace("StageType.Mixed", "StageType.Immersive") },
  { ruleId: "spatial.entity-content", apply: replace("SpatialView(entity)", "AndroidView(entity)") },
  { ruleId: "spatial.ui-lifecycle", apply: replace("PicoTheme", "MaterialTheme") },
  { ruleId: "ecs.component-clone", apply: replace("copy(selected = selected)", "CounterComponent()") },
  { ruleId: "ecs.system-query", apply: replace("private val counterQuery", "private val unrelatedQuery") },
  { ruleId: "ecs.frame-update", apply: replace("context.deltaTime", "0.016f") },
  { ruleId: "ecs.lifecycle", apply: replace("unregisterSystem(orbitSystem)", "registerSystem(orbitSystem)") },
  { ruleId: "state.single-source", apply: replace("val sharedStore = BenchmarkStore.instance", "val sharedStore = BenchmarkStore()") },
  { ruleId: "state.typed-handoff", apply: replace("GallerySelection(selectedId)", "selectedId") },
  { ruleId: "state.shared-read-write", apply: replace("stageStore = sharedStore", "stageStore = BenchmarkStore()") },
  { ruleId: "state.round-trip", apply: replace("visitCount += 1", "visitCount = 0") },
  { ruleId: "plane.retry-readiness", apply: replace("repeat(MAX_ANCHOR_RETRIES)", "repeat(1)") },
  { ruleId: "plane.semantic-fallback", apply: replace("?: horizontalFloorPlane()", "?: null") },
  { ruleId: "plane.anchor-pose", apply: replace("anchorPose.toSpatialPose()", "Pose(Vector3(0f, 1f, 0f))") },
  { ruleId: "plane.cleanup-errors", apply: replace("stopTrackingAndUnsubscribe()", "Unit") },
];
export function writeAndroidStyleProject(t) {}
```

Define `replace(from, to)` as an exact-one-occurrence edit that throws for zero or multiple matches.
Name the complete fixture declarations to match the literals above, and make each mutation affect
only its named rule. The test compares the complete sixteen-element boolean vector, not only totals.

- [ ] **Step 6: Run scorer and conformance gates**

```bash
node --test test/agentbench-source.mjs test/agentbench-score.mjs
npm run test:conformance
```

Expected: agentbench tests pass and conformance reports `Failures: 0`.

- [ ] **Step 7: Commit the scorer**

```bash
git add benchmarks/spatial-agent-bench/lib/rules-spatial.mjs benchmarks/spatial-agent-bench/lib/rules-behavior.mjs benchmarks/spatial-agent-bench/lib/score.mjs test/helpers/agentbench-fixture.mjs test/agentbench-score.mjs
git commit -m "feat(bench): score four spatial agent failure modes"
```

---

### Task 4: Bounded Claude CLI Process and Treatment Isolation

**Files:**
- Create: `benchmarks/spatial-agent-bench/lib/process.mjs`
- Create: `test/fixtures/agentbench/fake-claude.mjs`
- Create: `test/agentbench-process.mjs`

**Interfaces:**
- Consumes: lane, prompt, scratch directory, MCP config, scrubbed environment, and timeout.
- Produces: `probeClaudeInstallation`, `buildClaudeInvocation`, `runClaudeAttempt`, and `parseClaudeStream`.

- [ ] **Step 1: Write failing invocation, auth, and stream tests**

Assert this literal argument vector:

```js
assert.deepEqual(invocation.args, [
  "-p",
  "--effort=high",
  "--autocompact=auto",
  "--max-turns=100",
  "--input-format=text",
  "--output-format=stream-json",
  "--verbose",
  "--include-hook-events",
  "--setting-sources", "",
  `--settings=${settingsPath}`,
  "--strict-mcp-config",
  "--no-chrome",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--prompt-suggestions=false",
  "--tools=Bash,Read,Write,Edit,Glob,Grep",
  "--disallowedTools=Agent,Task,WebSearch,WebFetch,AskUserQuestion,Skill",
  "--permission-mode=dontAsk",
  `--session-id=${runId}`,
  "--model=claude-sonnet-5",
  `--mcp-config=${mcpConfigPath}`,
  "--allowedTools=Bash,Read,Write,Edit,Glob,Grep,mcp__pico-spatial__*",
]);
assert.equal(invocation.args.includes("--fallback-model"), false);
assert.equal(invocation.args.includes("--bare"), false, "bare disables Max OAuth/keychain");
assert.equal(invocation.args.includes("--safe-mode"), false, "safe mode disables explicit MCP treatment");
```

Use the fake CLI to assert expected-model success, wrong-model rejection, fallback-event rejection,
refusal, timeout, output-cap failure, and descendant cleanup. Feed an auth fixture containing email
and org ID; assert the returned value contains only Max/auth method plus a salted SHA-256 account
fingerprint. Raw email and org ID must not survive serialization. Assert the pinned Claude binary
version is `2.1.233` and its native executable SHA-256 matches the corpus preflight value.

- [ ] **Step 2: Run the test and observe RED**

```bash
node --test test/agentbench-process.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/process.mjs`.

- [ ] **Step 3: Implement strict MCP and settings files**

Write bare config as exactly `{ "mcpServers": {} }`. Write the treatment config as exactly one
stdio server:

```js
{
  mcpServers: {
    "pico-spatial": {
      type: "stdio",
      command: process.execPath,
      args: [absoluteDistIndex],
      env: {
        PICO_MCP_SURFACE: "doors",
        PATH: mcpPathWithoutPicoCli,
      },
      timeout: 900_000,
      alwaysLoad: true,
    },
  },
}
```

The settings file is `{}`. Remove `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, all
`CLAUDE_CODE_USE_*` provider selectors, all model/fallback overrides, and the inherited effort
override. Set `CLAUDE_CODE_NO_MODEL_FALLBACK=1`, `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP=1`,
`CLAUDE_CODE_DISABLE_FAST_MODE=1`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`,
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
`DISABLE_AUTOUPDATER=1`, `MCP_TIMEOUT=30000`, `MCP_CONNECT_TIMEOUT_MS=10000`, and
`MCP_TOOL_TIMEOUT=900000`. Keep the normal Max keychain/OAuth path available. The bare child PATH
contains only the staged pico-cli toolchain plus shared system tools; the MCP child PATH omits
pico-cli. Pass prompt bytes on stdin with `shell:false`.

- [ ] **Step 4: Implement bounded process-tree lifecycle and stream validation**

Export:

```js
export async function runClaudeAttempt({
  command, args, cwd, env, stdin, timeoutMs,
  maxOutputBytes = 64 * 1024 * 1024,
}) {}
```

Stream stdout to `stdout.ndjson` and stderr to `stderr.log` while hashing and enforcing the combined
limit. On POSIX use a detached process group; on Windows terminate the full tree with `taskkill`.
Allow 5 seconds after TERM before KILL and wait for settlement. Return partial hashes and explicit
`timedOut`, `outputExceeded`, `exitCode`, and `signal`; do not throw for model exit.

`parseClaudeStream` requires one init event, assistant messages whose model equals the lane model,
and one terminal result. It rejects fallback/rate-provider substitutions and unexpected models in
`modelUsage`. The init event must report `apiKeySource: "oauth"` and the exact frozen local tool
set. Bare smoke must observe zero MCP servers; MCP smoke must observe exactly `pico-spatial`
connected with its doors tools. Extra MCP servers, connection errors, absent treatment, or another
model rejects the attempt before inclusion. Persist nominal `total_cost_usd` only as CLI usage
metadata labeled `not_incremental_spend`; Max quota remaining is not observable and must be reported
as unknown.

- [ ] **Step 5: Run the process gate and observe GREEN**

```bash
node --test test/agentbench-process.mjs
```

Expected: all fake success/failure/lifecycle cases pass and no descendant remains.

- [ ] **Step 6: Commit the process boundary**

```bash
git add benchmarks/spatial-agent-bench/lib/process.mjs test/fixtures/agentbench/fake-claude.mjs test/agentbench-process.mjs
git commit -m "feat(bench): isolate and bound Claude benchmark runs"
```

---

### Task 5: Guarded Arbitrary-Submission Build Receipt

**Files:**
- Create: `benchmarks/spatial-agent-bench/lib/build-receipt.mjs`
- Create: `test/agentbench-build-receipt.mjs`

**Interfaces:**
- Consumes: an agent-authored Gradle project, expected package, task `:app:assembleDebug`, and injected command runner.
- Produces: `produceAgentBenchBuildReceipt(input, deps)` and `validateAgentBenchBuildReceipt(receipt)`.

- [ ] **Step 1: Write the failing receipt contract tests**

Use an injected command runner and temporary Gradle-shaped project. Assert exact commands:

```js
assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
  [path.join(projectDir, "gradlew"), ["--no-daemon", ":app:assembleDebug", "--console=plain"]],
  [path.join(projectDir, "gradlew"), ["--no-daemon", ":app:testDebugUnitTest", "--console=plain"]],
]);
```

Assert a successful receipt binds pre/post guarded Gradle inputs, output metadata, and APK bytes.
Add cases for source mutation during build, timeout, non-zero assemble, absent or ambiguous output
metadata, package mismatch, unit-test failure, tampered receipt, escaping symlink, and a dirty output
already present before the clean build.

- [ ] **Step 2: Run the receipt test and observe RED**

```bash
npm run build
node --test test/agentbench-build-receipt.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/build-receipt.mjs`.

- [ ] **Step 3: Implement a benchmark-specific receipt without fleet lineage**

Reuse, do not copy, these landed exports:

```js
import {
  canonicalJson,
  canonicalIdentity,
  collectGuardedGradleInputIdentity,
  collectGradleInputIdentity,
} from "../../../dist/runreceiptidentity.js";
import { resolveAssembledApk } from "../../../dist/workflow.js";
```

The strict receipt shape is:

```js
{
  kind: "pico.spatial-agent-build-receipt",
  schemaVersion: 1,
  runId,
  project: { gradleInputs: { sha256, entryCount, totalBytes } },
  assemble: { command, args, startedAt, finishedAt, exitCode, timedOut, stdoutSha256, stderrSha256 },
  unitTests: { command, args, startedAt, finishedAt, exitCode, timedOut, stdoutSha256, stderrSha256 },
  outputMetadata: { sha256, bytes },
  apk: { sha256, bytes },
  packageName,
  buildPass,
  identity: { algorithm: "sha256", sha256, bytes },
}
```

Collect a guarded input identity before either command, prove it unchanged after both commands, and
compare a fresh post-build identity byte-for-byte. Close the guard in a `finally` block on success,
command failure, timeout, or thrown validation error. Clean only the generated `app/build/`
directory inside the already validated project root before the guarded snapshot. Resolve exactly
one APK through AGP output metadata. `buildPass` requires model delivery, assemble success, correct
package, and a newly hashed APK; unit-test outcome remains separate evidence.
Compute `identity` with `canonicalIdentity` over the complete receipt excluding the `identity` field;
the validator rejects unknown keys, inconsistent booleans, malformed hashes, and identity mismatch.

This is an experiment receipt, not `pico.native-run-receipt`, not `fleet-native-debug`, and not a
trust-ledger binding. Never synthesize an AppSpec or rewrite the model submission to satisfy fleet
receipt constraints.

- [ ] **Step 4: Run receipt and provenance gates**

```bash
npm run build
node --test test/agentbench-build-receipt.mjs
npm run test:runreceipt
```

Expected: benchmark receipt tests pass and the owner's 208 run-receipt tests remain green.

- [ ] **Step 5: Commit the build receipt**

```bash
git add benchmarks/spatial-agent-bench/lib/build-receipt.mjs test/agentbench-build-receipt.mjs
git commit -m "feat(bench): seal arbitrary agent build inputs"
```

---

### Task 6: Append-Only Experiment Store and Statistics

**Files:**
- Create: `benchmarks/spatial-agent-bench/lib/store.mjs`
- Create: `benchmarks/spatial-agent-bench/lib/report.mjs`
- Create: `test/agentbench-store-report.mjs`

**Interfaces:**
- Consumes: external run root, repository root, immutable attempts, and score documents.
- Produces: `assertExternalRunRoot`, `startAttempt`, `finishAttempt`, `readAttempts`, `aggregateRuns`, and disabled `exportSanitizedReport`.

- [ ] **Step 1: Write failing store-integrity tests**

Test lexical and realpath containment, including an external-looking symlink into the repository:

```js
assert.throws(() => assertExternalRunRoot(repoRoot, repoRoot), /outside/i);
assert.throws(() => assertExternalRunRoot(repoRoot, path.join(repoRoot, "nested")), /outside/i);
assert.throws(() => assertExternalRunRoot(repoRoot, symlinkIntoRepo), /real path|outside/i);
const started = startAttempt(store, input);
assert.throws(() => startAttempt(store, { ...input, attemptId: started.attemptId }), /exists|overwrite/i);
finishAttempt(store, started.attemptId, outcome);
assert.throws(() => finishAttempt(store, started.attemptId, outcome), /exists|overwrite/i);
```

Corrupt a terminal record and assert it appears only under `rejected`. Leave a start record without
a terminal record and assert it remains `incomplete`; resume uses a new UUID.

- [ ] **Step 2: Write failing statistics and claim-bar tests**

Use literal synthetic attempts to assert mean, median, range, per-axis means, build rate, paired
differences, and a seeded 10,000-sample interval. Five pairs classify as `preliminary`. Ten positive
pairs classify as `signoff-candidate`. A non-positive lower interval, lower build rate, or any axis
delta below `-0.5` classifies as `signoff-not-met`.

Assert production `exportSanitizedReport` always throws `PICO guidance and denylist required`.
Test a separate projection validator with synthetic denied canaries and unknown raw fields.

- [ ] **Step 3: Run the store/report test and observe RED**

```bash
node --test test/agentbench-store-report.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/store.mjs`.

- [ ] **Step 4: Implement create-only storage and digest validation**

Use `fs.openSync(path, "wx", 0o600)`, `fs.fsyncSync`, and no-replace publication. Store
`attempts/<uuid>/started.json`, append-only hash-chained `events.jsonl`, and create-only
`outcome.json`/`score.json`. Each event carries `sequence`, `previousEventSha256`, and its canonical
event hash. `readAttempts` recomputes every digest and returns `{ valid, incomplete, rejected }`.

- [ ] **Step 5: Implement deterministic aggregation**

Export:

```js
export function aggregateRuns(attempts, { seed, bootstrapSamples = 10_000 } = {}) {}
export function pairedBootstrap(differences, { seed, samples = 10_000 } = {}) {}
export function validateSanitizedProjection(value, policy) {}
export function exportSanitizedReport() {
  throw new Error("PICO guidance and denylist required");
}
```

Use a SHA-256 counter PRNG, include treatment failures as zeros, and exclude only declared smoke/NA
rows. Normalize all keys before hashing. Private reports may reference raw paths; score documents
and aggregate objects may not contain prompts, auth fields, streams, stderr/stdout, or captures.

- [ ] **Step 6: Run the store/report gate and observe GREEN**

```bash
node --test test/agentbench-store-report.mjs
```

Expected: all integrity, statistics, and disabled-export tests pass.

- [ ] **Step 7: Commit the evidence store and reporter**

```bash
git add benchmarks/spatial-agent-bench/lib/store.mjs benchmarks/spatial-agent-bench/lib/report.mjs test/agentbench-store-report.mjs
git commit -m "feat(bench): preserve and aggregate agent run evidence"
```

---

### Task 7: Receipt-Independent Serial Runner

**Files:**
- Create: `benchmarks/spatial-agent-bench/lib/runner.mjs`
- Create: `benchmarks/spatial-agent-bench/run.mjs`
- Create: `test/agentbench-runner.mjs`

**Interfaces:**
- Consumes: frozen corpus, repository checkout, explicit external run root, selected phase, and
  injected process/build dependencies.
- Produces: `prepareRun`, `smokeLanes`, `runPreliminaryCohort`, `runSignoffCohort`, and
  `resumeCohort` checkpoints that never mutate an existing attempt.

- [ ] **Step 1: Write failing preflight and serial-runner tests**

Use fake Claude/build dependencies and assert the exact phase order:

```js
assert.deepEqual(events.map((event) => event.phase), [
  "preflight", "reference-build", "pair-start",
  "sonnet_mcp", "opus_bare", "pair-complete",
]);
assert.equal(maxConcurrentClaude, 1);
assert.equal(maxConcurrentGradle, 1);
assert.equal(attempts[0].scratchDir.startsWith(runRoot + path.sep), true);
assert.notEqual(attempts[0].scratchDir, attempts[1].scratchDir);
```

Cover dirty checkout, missing P0 tests, wrong SDK, wrong CLI tarball integrity, stale MCP build,
reference-build failure, account-block mismatch, treatment failure scored as zero, infrastructure
failure reclassified only after an immediate failing reference build, refusal to selectively rerun,
and restart from a new attempt UUID after interruption. Assert a matched pair finishes before the
next pair begins.

- [ ] **Step 2: Run the runner test and observe RED**

```bash
node --test test/agentbench-runner.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/runner.mjs`.

- [ ] **Step 3: Implement `prepareRun` with fail-closed provenance**

`prepareRun` must:

1. resolve and validate the external run root before creating files;
2. require a clean tracked checkout and record the full Git commit;
3. run `npm run build`, `npm run test:ledger`, and `npm run test:runreceipt`, requiring the landed
   P0 expectations of zero ledger failures and at least 208 run-receipt passes with no failures;
4. hash the built `dist/index.js`, Claude native executable, corpus, prompt, and scorer files;
5. require Claude Code `2.1.233` and sanitize `claude auth status --json` immediately into the
   blinded Max-account block without persisting raw auth output;
6. fetch `@picoxr/pico-cli@0.4.2` with `npm pack --json`, require integrity
   `sha512-qapgwB+OljD0qQukilhaAmhIemuoIvMO/dkQOVDcZEhLdW1KxpbpkNyLII9hJ6m5F/QYF4UZoPpkjH9IL5U7mA==`,
   and install that exact tarball into the external toolchain directory;
7. derive a shared base PATH that contains no other `pico-cli` executable, prepend the staged CLI
   bin only for bare lanes, and assert MCP lanes cannot resolve `pico-cli`;
8. copy tracked `appskeleton/` into an external reference directory, verify Spatial SDK `0.13.3`,
   and build `com.example.spatialapp` through `produceAgentBenchBuildReceipt`.

The preflight manifest records hashes and sanitized facts, not absolute home paths or raw account
identifiers. A stale `dist/`, failed owner gate, unclean tracked tree, unpinned tool, or failed
reference build stops before any model call.

- [ ] **Step 4: Implement one-call attempts and matched-pair checkpoints**

For each scheduled lane, create an empty external scratch directory, render the shared prompt, write
the strict settings/MCP files, call Claude exactly once, require delivery under `submission/`, seal
the build receipt, score the source, and finish the append-only attempt. Never repair generated
source or issue a second model turn. Record visual evidence as `not_performed` unless the exact
capture is later opened and judged.

Pair both primary attempts to the same blinded account block. If the second attempt would use a
different block or the account reaches quota, stop between attempts and invalidate the unpaired
start; restart both lanes under one block with new UUIDs. After a suspected infrastructure failure,
immediately rebuild the untouched reference copy: only the same failure permits `NA`; otherwise the
model attempt remains a zero. Checkpoint only a complete pair.

- [ ] **Step 5: Add the human-invoked CLI**

`run.mjs` accepts exactly:

```text
prepare --run-root ABSOLUTE_PATH
smoke --run-root ABSOLUTE_PATH
run --run-root ABSOLUTE_PATH --cohort preliminary
run --run-root ABSOLUTE_PATH --cohort signoff
report --run-root ABSOLUTE_PATH --format private-json
export --run-root ABSOLUTE_PATH
```

Reject unknown flags and relative paths. `smoke` performs one excluded run in each of the four
lanes and validates init metadata before measured work. `export` calls the deliberately disabled
export function and exits non-zero with `PICO guidance and denylist required`.

- [ ] **Step 6: Run runner, provenance, and regression gates**

```bash
npm run build
node --test test/agentbench-process.mjs test/agentbench-build-receipt.mjs test/agentbench-runner.mjs
npm run test:ledger
npm run test:runreceipt
```

Expected: fake runner tests pass, ledger reports zero failures, and run-receipt reports at least the
independently observed 208 passes with no failures.
No test invokes a real model, emulator, network, Swan device, or Windows host.

- [ ] **Step 7: Commit the runner**

```bash
git add benchmarks/spatial-agent-bench/lib/runner.mjs benchmarks/spatial-agent-bench/run.mjs test/agentbench-runner.mjs
git commit -m "feat(bench): run paired agent cohorts serially"
```

---

### Task 8: Package, CI, and Reproduction Gates After the P0 Lane Lands

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/gates.yml`
- Modify: `scripts/verify-tarball.mjs`
- Create: `docs/SPATIAL_AGENT_BENCH.md`
- Create: `test/agentbench-package.mjs`

**Interfaces:**
- Produces: a deterministic `test:agentbench` gate and an explicitly manual live runner. Benchmark
  implementation and result artifacts remain absent from the npm package.

- [ ] **Step 1: Write the failing package-boundary test**

Create `test/agentbench-package.mjs` that runs `npm pack --json --dry-run`, parses the file list, and
asserts no entry starts with any of these prefixes:

```js
const PRIVATE_PREFIXES = [
  "benchmarks/", ".dev/", "test/agentbench-", "test/helpers/agentbench-",
];
```

Also assert `package.json` has `test:agentbench` but no script that invokes `run.mjs run`, and that
the workflow invokes only the deterministic test target.

- [ ] **Step 2: Run the package test and observe RED**

```bash
node --test test/agentbench-package.mjs
```

Expected: FAIL because `test:agentbench` and its CI gate do not exist.

- [ ] **Step 3: Wire deterministic tests without publishing the harness**

Add exactly:

```json
"test:agentbench": "node --test --test-concurrency=1 test/agentbench-*.mjs"
```

Add a Linux CI step named `SpatialAgentBench deterministic harness` after `test:runreceipt`. It runs
only `npm run test:agentbench`; it has no Claude credentials and makes no live model call. Extend the
tarball gate to reject the four private prefixes above from the actual packed file list. Do not add
`benchmarks/` or benchmark tests to the package `files` array.

- [ ] **Step 4: Document exact reproduction and evidence limits**

`docs/SPATIAL_AGENT_BENCH.md` must include the frozen hypothesis, all four lanes, 16 rule IDs,
commands from Task 7, Max/no-API-spend boundary, nominal-cost warning, timeout/refusal/NA semantics,
private external-root requirement, preliminary-versus-sign-off thresholds, and these explicit
limitations: no Swan hardware, no Windows validation, no visual claim without an inspected capture,
and no result export before PICO guidance. It must not contain model scores or emulator-derived
confidential identifiers.

- [ ] **Step 5: Run the complete deterministic gate**

```bash
npm run build
npm run test:agentbench
npm run test:ledger
npm run test:runreceipt
npm run test:conformance
npm run test:tarball
```

Expected: every command passes; conformance reports `Failures: 0`, ledger reports zero failures,
run-receipt reports at least 208 passes with no failures, and the packed tarball contains no
benchmark implementation or data.

- [ ] **Step 6: Commit package and CI integration**

```bash
git add package.json .github/workflows/gates.yml scripts/verify-tarball.mjs docs/SPATIAL_AGENT_BENCH.md test/agentbench-package.mjs
git commit -m "test(bench): gate reproducibility without shipping corpus"
```

---

### Task 9: Run and Report the Preliminary Cohort Privately

**Files:**
- Create outside Git: `$PICO_AGENTBENCH_RUN_ROOT/**`
- Create ignored local finding: `.dev/findings/SPATIAL_AGENT_BENCH_2026-08-16.md`

**Interfaces:**
- Consumes: current Max OAuth session, frozen preliminary schedule, passing deterministic gates.
- Produces: five primary matched pairs, six declared control runs, four excluded smoke runs, a
  private aggregate, and an honest preliminary classification.

- [ ] **Step 1: Establish an external run root and rerun provenance gates**

```bash
PICO_AGENTBENCH_RUN_ROOT="$(mktemp -d /tmp/pico-agentbench-v1.XXXXXX)"
npm run build
npm run test:ledger
npm run test:runreceipt
node benchmarks/spatial-agent-bench/run.mjs prepare --run-root "$PICO_AGENTBENCH_RUN_ROOT"
```

Expected: the receipt gates pass on the exact checkout, preparation records only sanitized auth,
and the reference app builds before model use. Keep this task-specific variable in the active shell;
do not repurpose `HOME`, `CODEX_HOME`, or a shared system variable.

- [ ] **Step 2: Run four excluded smoke attempts**

```bash
node benchmarks/spatial-agent-bench/run.mjs smoke --run-root "$PICO_AGENTBENCH_RUN_ROOT"
```

Require the stream init event to prove the exact canonical model and frozen local-tool list. Bare
must report no MCP server; treatment must report exactly one connected `pico-spatial` doors server.
If any smoke fails, fix the harness and restart all four smoke attempts under new UUIDs before
freezing measured execution.

- [ ] **Step 3: Run all preliminary attempts serially**

```bash
node benchmarks/spatial-agent-bench/run.mjs run --run-root "$PICO_AGENTBENCH_RUN_ROOT" --cohort preliminary
```

Run the five primary pairs in the frozen order and then the six controls, for sixteen measured model
sessions. Together with smoke, the preliminary exercise uses twenty model sessions. Use the current
Max account for a complete pair. The second Max account is used only after the user switches auth at
a pair boundary; never log out, switch accounts, or expose account details automatically.

- [ ] **Step 4: Generate and independently audit the private report**

```bash
node benchmarks/spatial-agent-bench/run.mjs report --run-root "$PICO_AGENTBENCH_RUN_ROOT" --format private-json
```

Verify attempt counts, pair IDs, raw score evidence, build receipts, exclusions, and bootstrap inputs
against stored hashes. Record actual per-lane 0–16 scores, per-axis scores, build rates, paired
differences, 95% interval, elapsed times, and failure reasons in the ignored local finding. Label
five pairs `preliminary` even if Sonnet+MCP wins every pair; do not call it PICO sign-off.

- [ ] **Step 5: Record the evidence boundary and commit no measured artifacts**

If no rendered capture was opened, set every visual field to `not_performed`. State explicitly that
the run provides macOS host/model evidence only and provides no Swan-hardware or Windows result.
Confirm Git contains none of the run root, generated projects, streams, raw prompts, auth fields,
captures, or measured report:

```bash
git status --short
git check-ignore -v .dev/findings/SPATIAL_AGENT_BENCH_2026-08-16.md
```

Expected: only intentional source/doc changes are tracked, and the local finding is ignored. Do not
run `export`; measured publication remains blocked pending PICO guidance.
