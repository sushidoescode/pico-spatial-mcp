# Home Environment Fit Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one full-only `select_home_environment` tool that ranks measured PICO Emulator 6.0 environments, performs guarded macOS selection, and verifies the target only through unique receipt-bound mesh classification.

**Architecture:** A packaged, versioned JSON dataset feeds a pure catalog/ranking/classification module. A separately injected macOS host driver owns serial-bound Accessibility/CGEvent actions. A thin live orchestrator binds WorldSpace context and the existing receipt-bound scene-anchor query to those pure pieces, then registers one full-surface MCP tool.

**Tech Stack:** TypeScript, Zod, MCP SDK, Node.js tests against built `dist/`, adb/logcat, macOS CoreGraphics/Accessibility Swift helper, npm tarball verification.

**Spec:** `docs/superpowers/specs/2026-08-30-home-environment-fit-selector-design.md`

## Global Constraints

- `package.json` and every manifest version remain `37.0.0`; there is no version bump.
- Register exactly one new full-surface tool; macOS full becomes 252, other-host full 249, doors/default remains 18.
- Add no npm script; attach new tests to the existing `test:bridge` script.
- Runtime data must be `assets/home-environments/pico-emulator-6.0.v1.json`, and that directory must contain only that file.
- Mesume Day remains excluded with its zero-geometry/public-parser reason in the packaged dataset.
- WALL_ART remains advisory and has no extent score.
- Scene ID and host tile click never identify an environment; any histogram-range ambiguity fails closed.
- All adb work names `emulator-5554` explicitly; never address the attached physical serial.
- No snapshot save/load, gate save, calibration, or release operation.
- Run `npm run build` before every test command because tests import `dist/`.
- `benchmarks/**` and `test/agentbench-*` remain byte-unchanged.
- Task-level commits are temporary review checkpoints. After Task 7 passes, squash every post-CP1
  checkpoint through the live selector evidence into one unpushed CP2 commit, preserving the
  user's one-final-commit-per-CP requirement. CP1 and CP3 remain separate commits.

---

### Task 1: Packaged Dataset and Pure Fit Catalog

**Files:**
- Create: `assets/home-environments/pico-emulator-6.0.v1.json`
- Create: `src/homeenvironmentcatalog.ts`
- Create: `test/homeenvironmentcatalog.mjs`

**Interfaces:**
- Consumes: CP1 `capability-summary.json`, `selection-provenance.json`, and AppSpec exports `appSpecSchema` plus `findBriefPath`.
- Produces: `loadPackagedHomeEnvironmentDataset()`, `deriveFitRequest(input)`, `rankHomeEnvironments(dataset, request)`, and exported strict TypeScript/Zod dataset/result types.

- [ ] **Step 1: Write failing loader, derivation, and rank tests**

Create tests that import the missing module and assert the approved contract:

```js
import {
  loadPackagedHomeEnvironmentDataset,
  deriveFitRequest,
  rankHomeEnvironments,
} from "../dist/homeenvironmentcatalog.js";

const dataset = loadPackagedHomeEnvironmentDataset();
assert.equal(dataset.datasetId, "pico-emulator-6.0-home-environments-v1");
assert.deepEqual(fs.readdirSync(path.join(repo, "assets/home-environments")), [
  "pico-emulator-6.0.v1.json",
]);
assert.equal(dataset.environments.find((entry) => entry.tile === "Mesume Day").automaticSelectionEligible, false);

const mission = deriveFitRequest({ briefId: "swanmissiontable" });
assert.deepEqual(mission.preferred.requirement, { label: "TABLE", minimumExtentM: [0.25, 0.18] });
assert.deepEqual(mission.fallback.requirement, { label: "FLOOR", minimumExtentM: [0.8, 0.55] });
assert.equal(mission.advisories[0].label, "WALL_ART");

const ranked = rankHomeEnvironments(dataset, mission);
assert.equal(ranked.candidates[0].tile, "Livingroom Day");
assert.equal(ranked.candidates[1].tile, "Livingroom Night");
assert.ok(Math.abs(ranked.candidates[0].contentScale - 0.774) < 0.002);
assert.equal(ranked.candidates[0].contentScale, ranked.candidates[1].contentScale);
assert.ok(!ranked.candidates.some((entry) => entry.tile === "Mesume Day"));
```

Also assert simultaneous explicit TABLE+FLOOR requirements, ordered X/Z dimensions, unsafe/missing
brief IDs, absent/non-swan roomExperience, wrong stage AppSpecs, unsupported labels, and no-fit
results.

- [ ] **Step 2: Run the test to verify RED**

Run: `npm run build && node --test test/homeenvironmentcatalog.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `dist/homeenvironmentcatalog.js`.

- [ ] **Step 3: Add the exact versioned dataset**

Transcribe the CP1 ranges/extents and selection hashes into a strict JSON document. The environment
shape must include explicit eligibility for every row:

```json
{
  "schemaVersion": 1,
  "datasetId": "pico-emulator-6.0-home-environments-v1",
  "classification": { "extentToleranceM": 0.01, "labels": ["FLOOR", "TABLE"] },
  "environments": [
    {
      "tile": "Mesume Day",
      "automaticSelectionEligible": false,
      "exclusionReason": "public query_scene_anchors invalid_payload: stable anchor 33 has zero vertices and indices",
      "measurementStatus": "invalid_payload"
    }
  ]
}
```

Include the CP1 source commit/path, contact-sheet and selection-log SHA-256 values, selected-dialog
hashes, measured click points, complete histogram ranges, total ranges, and all measured FLOOR/TABLE
X/Y/Z extents. Keep the directory to exactly one JSON file.

- [ ] **Step 4: Implement strict load, derivation, and ranking**

Use module-relative packaged resolution, never the unshipped docs tree:

```ts
const DATASET_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "assets", "home-environments", "pico-emulator-6.0.v1.json",
);

export function loadPackagedHomeEnvironmentDataset(): HomeEnvironmentDataset {
  return homeEnvironmentDatasetSchema.parse(JSON.parse(fs.readFileSync(DATASET_PATH, "utf8")));
}
```

Validate brief IDs with `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, resolve via `findBriefPath`, parse
`.spec` with `appSpecSchema`, and derive TABLE preferred/FLOOR fallback/WALL_ART advisory. Implement
the exact explicit fit ratio and mission-table scale formulas from the design. Rank refreshed
proposals from every measured-potential `extentClusters` representative, falling back to legacy
`surfaces` only for extension-absent v1 entries; `guaranteedSurfaces` describes observed recurrence
and is not a ranking input. Reject a cluster whose observed maximum is zero, require refreshed
`surfaces` and cluster representatives to match exactly one-to-one, and require guarantees to be the
exact duplicate-free projection of positive-minimum clusters. Use dataset order as the final
tiebreak, including the equal approximately 0.774 Livingroom Day/Night mission proposals.

- [ ] **Step 5: Run the focused test to verify GREEN**

Run: `npm run build && node --test test/homeenvironmentcatalog.mjs`

Expected: all catalog tests pass.

- [ ] **Step 6: Commit the catalog slice**

```bash
git add assets/home-environments/pico-emulator-6.0.v1.json src/homeenvironmentcatalog.ts test/homeenvironmentcatalog.mjs
git commit -m "feat: rank measured home environment fit"
```

---

### Task 2: Fail-Closed Mesh Fingerprint Classification

**Files:**
- Modify: `src/homeenvironmentcatalog.ts`
- Modify: `test/homeenvironmentcatalog.mjs`

**Interfaces:**
- Consumes: `HomeEnvironmentDataset` and the structured result shape validated by `querySceneAnchorsOutputSchema`.
- Produces: `classifyObservedHomeEnvironment(dataset, queryResult, requirements)` returning a unique match or an explicit zero/multiple-match failure with predicates.

- [ ] **Step 1: Add failing classification tests**

Build observed query fixtures from CP1 public results and assert:

```js
const livingDay = classifyObservedHomeEnvironment(dataset, livingroomDayQuery, requirements);
assert.equal(livingDay.status, "unique");
assert.equal(livingDay.environment.tile, "Livingroom Day");

const overlap = classifyObservedHomeEnvironment(overlapDataset, overlappingQuery, requirements);
assert.equal(overlap.status, "ambiguous");
assert.equal(overlap.environment, null);
assert.deepEqual(overlap.histogramMatches, ["Synthetic A", "Synthetic B"]);
```

Cover zero matches, an extra unmeasured label, a missing label interpreted as zero, total outside the
observed range, terminal bridge statuses, requested-label coverage, surface extent mismatch, Mesume
Day exclusion, WALL_ART not affecting identity, mandatory live fit for the global static mission
tier, simultaneous explicit requirements, and ambiguity stopping before cluster or fit predicates.

- [ ] **Step 2: Run the test to verify RED**

Run: `npm run build && node --test test/homeenvironmentcatalog.mjs`

Expected: FAIL because `classifyObservedHomeEnvironment` is absent.

- [ ] **Step 3: Implement histogram-first classification**

Implement the ambiguity boundary before checking target extents:

```ts
const histogramMatches = eligible.filter((environment) =>
  rangeContains(environment.totalAnchorCountRange, observed.totalAnchorCount)
  && completeHistogramFits(environment.histogramRanges, observed.histogram)
);
if (histogramMatches.length !== 1) {
  return {
    status: histogramMatches.length === 0 ? "no_match" : "ambiguous",
    environment: null,
    histogramMatches: histogramMatches.map((entry) => entry.tile),
    predicates,
  };
}
```

Only after a unique histogram match and requested-label coverage, require every live FLOOR/TABLE
extent to map to exactly one measured cluster within X/Y/Z `extentToleranceM` and validate all
cluster presence ranges. Only after those checks may explicit fit or the globally ranked mission
tier be evaluated. Never use scene ID, selected-dialog hash, extents, fit, or dataset order to break
a histogram tie.

- [ ] **Step 4: Run the test to verify GREEN**

Run: `npm run build && node --test test/homeenvironmentcatalog.mjs`

Expected: all catalog and classifier tests pass.

- [ ] **Step 5: Commit the classifier slice**

```bash
git add src/homeenvironmentcatalog.ts test/homeenvironmentcatalog.mjs
git commit -m "feat: classify environment mesh fingerprints"
```

---

### Task 3: Guarded macOS Environment Picker Driver

**Files:**
- Create: `src/homeenvironmenthost.ts`
- Create: `test/homeenvironmenthost.mjs`
- Modify: `src/cameradrive.ts`

**Interfaces:**
- Consumes: `BoundQemuWindow`, `QemuWindowBindingResult`, `selectQemuWindowBinding`, and picker metadata from the packaged dataset.
- Produces: `executeGuardedHostSelection(target, picker, deps)` plus production `defaultHomeEnvironmentHostDependencies()`.

- [ ] **Step 1: Write failing dependency-injected host tests**

Define fakes that count every attempted focus/open/click/capture/close action. Assert non-macOS,
offline serial, ambiguous PID/window, Accessibility denial, missing toolbar control, wrong dialog
PID/title/geometry, missing or duplicate labels, and capture failure all refuse before an unsafe
action.

Assert the proven happy path and hash refusal:

```js
const selected = await executeGuardedHostSelection(target, picker, happyDeps());
assert.equal(selected.status, "host_selection_observed");
assert.equal(selected.afterDialogSha256, target.selectedDialogSha256);
assert.equal(selected.close.closed, true);

const stale = await executeGuardedHostSelection(target, picker, happyDeps({ afterBytes: wrongPng }));
assert.equal(stale.status, "host_selection_not_observed");
assert.equal(stale.selectedTile, null);
```

Also prove the click point is dataset-relative to the validated dialog, the exact bound PID is
focused, and close verifies disappearance of the stored dialog identity.

- [ ] **Step 2: Run the host test to verify RED**

Run: `npm run build && node --test test/homeenvironmenthost.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Expose only the existing safe qemu production seams**

Export `bindMacQemuWindow` and `frontmostQemu` from `src/cameradrive.ts` without changing their
behavior. Keep `selectQemuWindowBinding` as the pure authority.

- [ ] **Step 4: Implement the injected guarded state machine**

Use a result union that never returns a generic selected state:

```ts
export type HostSelectionResult =
  | { status: "manual_switch_required"; targetTile: string; detail: string; baselineSafe: true }
  | { status: "host_selection_not_observed"; targetTile: string; detail: string; receipts: HostReceipt[] }
  | { status: "host_selection_observed"; targetTile: string; afterDialogSha256: string; receipts: HostReceipt[]; close: { closed: true } };
```

Production uses a temporary Swift Accessibility helper to recursively find the bound PID's
`select_scene_button`, dialog heading, close control, and six static-text labels. Correlate the AX
dialog frame to one CoreGraphics window ID. After every guard, focus the PID and issue exactly one
CGEvent at `dialogOrigin + datasetClickPoint`. Capture only that window with `screencapture -l`, hash
the PNG, require the dataset hash, close through AX, and re-probe absence.

- [ ] **Step 5: Run existing binding tests and the new host test**

Run: `npm run build && node --test test/observation.mjs test/homeenvironmenthost.mjs`

Expected: all tests pass.

- [ ] **Step 6: Commit the host slice**

```bash
git add src/cameradrive.ts src/homeenvironmenthost.ts test/homeenvironmenthost.mjs
git commit -m "feat: guard the macOS environment picker"
```

---

### Task 4: WorldSpace and Receipt-Bound Live Orchestration

**Files:**
- Create: `src/homeenvironmentselector.ts`
- Create: `test/homeenvironmentselector.mjs`
- Modify: `src/sceneanchors.ts`

**Interfaces:**
- Consumes: catalog rank/classify functions, guarded host selector, `executeQuerySceneAnchors`, exact runtime input, and optional `VerificationBaseline`.
- Produces: `parseCurrentDefaultSpace`, `executeSelectHomeEnvironment(input, deps)`, `selectHomeEnvironmentOutputSchema`, and `registerHomeEnvironmentSelectorTools(server)`.

- [ ] **Step 1: Write failing WorldSpace and orchestration tests**

Assert the parser accepts only current Default Space WorldSpaceDB lines and rejects malformed,
non-current, or non-Default Space rows. Use injected call-order spies:

```js
const result = await executeSelectHomeEnvironment(switchInput, deps);
assert.deepEqual(deps.calls, [
  "observe-pre", "query-pre", "mark", "host-select", "observe-post", "query-post",
]);
assert.equal(result.status, "selected_verified");
assert.notEqual(result.verification.preSnapshotId, result.verification.postSnapshotId);
assert.equal(result.verification.classification.environment.tile, "Livingroom Day");
```

Cover rank with no runtime calls; switch guard failure returning `manual_switch_required` plus a
baseline; verify requiring a matching baseline; boot/serial/package/receipt drift; unchanged
snapshot; coarse scene mismatch; every terminal bridge status; zero/multiple/wrong fingerprint;
host hash failure; and unique target success.

- [ ] **Step 2: Run the selector test to verify RED**

Run: `npm run build && node --test test/homeenvironmentselector.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Add one safe live scene-query wrapper**

In `src/sceneanchors.ts`, keep the current injected pure entrypoint and add:

```ts
export async function executeLiveQuerySceneAnchors(input: QuerySceneAnchorsInput) {
  return executeQuerySceneAnchors(input, defaultDependencies(resolveAdb()));
}
```

Update the existing `query_scene_anchors` handler to call this wrapper, ensuring the selector and
the public tool share identical binding/readiness behavior.

- [ ] **Step 4: Implement the live selector state machine**

Validate exactly one source and action-specific runtime/baseline requirements. Build the existing
strict scenario internally with root `stage`, count advisory, topology strict, and the current
numeric drift limits. Query `["TABLE", "FLOOR", "WALL_ART"]` with two stability reads.

Content-address the complete parsed dataset with the strict canonical JSON identity helper. Include
that `datasetContentSha256` in every public dataset receipt and switch baseline, and reject a missing
or different verify digest before ranking or any live dependency call.

The post path must check runtime identity and ambiguity before returning success:

```ts
if (post.snapshotId === baseline.snapshotId) return failed("snapshot_unchanged");
const classification = classifyObservedHomeEnvironment(dataset, post, fitRequest);
if (classification.status !== "unique") return failed(`classification_${classification.status}`);
if (classification.environment.tile !== target.tile) return failed("wrong_unique_environment");
return selectedVerified(/* complete structural receipts */);
```

Production WorldSpace observation writes a nonce marker to the exact adb serial, polls bounded
`logcat -d -v epoch` for the first later WorldSpaceDB line, and times out to verification failure.
Scene context is compared only for consistency and is labelled non-discriminating in output.

- [ ] **Step 5: Run selector plus existing scene-anchor tests**

Run: `npm run build && node --test test/sceneanchors.mjs test/homeenvironmentselector.mjs`

Expected: all tests pass, including existing proof that binding failure prevents bridge fetch.

- [ ] **Step 6: Commit the live orchestration slice**

```bash
git add src/sceneanchors.ts src/homeenvironmentselector.ts test/homeenvironmentselector.mjs
git commit -m "feat: verify selected environments by live mesh"
```

---

### Task 5: Full-Only Registration and Owning Suite Adoption

**Files:**
- Modify: `src/index.ts`
- Modify: `package.json` (`test:bridge` command only; version untouched)
- Modify: `GETTING_STARTED.md`
- Modify: `test/homeenvironmentselector.mjs`

**Interfaces:**
- Consumes: `registerHomeEnvironmentSelectorTools`.
- Produces: one full-only MCP tool named `select_home_environment`; no doors registration.

- [ ] **Step 1: Add a failing surface-registration assertion**

Extend the selector test's stdio harness to assert full tools include the new name and doors tools do
not. Keep the existing exact 18-name doors assertion authoritative.

- [ ] **Step 2: Run to verify RED**

Run: `npm run build && node --test test/homeenvironmentselector.mjs`

Expected: FAIL because the tool is not registered.

- [ ] **Step 3: Register inside the full-only block**

Import the registrar in `src/index.ts` and call it beside the existing host/scene environment tools,
strictly inside `if (!doorsSurfaceActive())`.

- [ ] **Step 4: Attach tests to the existing npm script and document the tool**

Change only the existing script value:

```json
"test:bridge": "node test/mousebridge.mjs && node --test test/sceneanchors.mjs test/homeenvironmentcatalog.mjs test/homeenvironmenthost.mjs test/homeenvironmentselector.mjs"
```

Add GETTING_STARTED examples for rank, switch, manual baseline→verify, and every fail-closed status.
State that scene ID/click do not prove identity and that Mesume Day/WALL_ART retain their exclusions.

- [ ] **Step 5: Run registration/doors/owning tests**

Run: `npm run build && npm run test:bridge && npm run test:doors`

Expected: all pass; doors remains 18.

- [ ] **Step 6: Commit registration and docs**

```bash
git add src/index.ts package.json GETTING_STARTED.md test/homeenvironmentselector.mjs
git commit -m "feat: expose full-surface environment selection"
```

---

### Task 6: Tool-Count Chain and Installed-Dataset Shipping Gate

**Files:**
- Modify: `scripts/verify-tarball.mjs`
- Modify: `scripts/sync-metadata.mjs`
- Modify: `test/distribution-adoption.mjs`
- Modify: stamper-owned count prose/manifests emitted by `npm run sync:meta`

**Interfaces:**
- Consumes: registered full tool and packaged dataset.
- Produces: exact 252/249/18 count assertions, installed dataset canary, and synchronized metadata without changing version 37.0.0.

- [ ] **Step 1: Update exact count and tool anchors**

In `verify-tarball.mjs`, change only the load-bearing literal shapes:

```js
const EXPECTED_TOOLS = 252;
const EXPECTED_OTHER_HOST_TOOLS = 249;
```

Add `select_home_environment` after the `// core lanes` boundary so the doors-name parser remains
18. Update distribution-adoption's exact source regexes and prose expectations to 252/249.

- [ ] **Step 2: Add the installed dataset canary**

After locating the installed tarball root, assert:

```js
const homeEnvironmentDir = path.join(installed, "assets", "home-environments");
const homeEnvironmentFiles = fs.readdirSync(homeEnvironmentDir).sort();
assert.deepEqual(homeEnvironmentFiles, ["pico-emulator-6.0.v1.json"]);
const homeEnvironmentDataset = JSON.parse(fs.readFileSync(path.join(homeEnvironmentDir, homeEnvironmentFiles[0]), "utf8"));
homeEnvironmentDataset.datasetId === "pico-emulator-6.0-home-environments-v1"
  ? ok("home environment dataset ships in the installed package")
  : fail("installed home environment dataset identity is wrong");
```

Use the gate's existing `ok`/`fail` style rather than importing `assert` if it has no assertion
import. Check Mesume Day's exclusion reason in the installed bytes.

- [ ] **Step 3: Preserve historical count rewriting and run the stamper**

Append 251 to `PUBLISHED_COUNTS`; do not change package/manifests versions. Run:

`npm run sync:meta`

Review every emitted hunk and reject any change beyond count prose/description stamping plus the
intentional selector documentation.

- [ ] **Step 4: Measure and verify the complete chain**

Run, rebuilding before each suite:

```bash
npm run build && npm run test:tarball
npm run build && npm run test:docsmeta
npm run build && npm run test:doors
npm run build && npm run test:adoption-safety
npm run build && npm run test:distribution-adoption
```

Expected: installed macOS full tools/list = 252, other-host expected = 249, doors/default = 18,
dataset canary passes, docsmeta failures 0, adoption-safety 48/0, distribution-adoption 41/2 with
only the two known failures.

- [ ] **Step 5: Prove versions and protected paths are untouched**

Run:

```bash
test "$(node -p 'require("./package.json").version')" = "37.0.0"
git diff 51df74d -- package.json plugin.json '.claude-plugin/*.json' | rg '^[+-].*version' && exit 1 || true
git diff --name-only 51df74d -- benchmarks 'test/agentbench-*'
git diff --check
```

Expected: version assertion passes, no version diff, no protected paths, no whitespace errors.

- [ ] **Step 6: Commit the count/shipping chain**

```bash
git add scripts/verify-tarball.mjs scripts/sync-metadata.mjs test/distribution-adoption.mjs README.md GETTING_STARTED.md TESTERS.md QUICKSTART.md SKILLS.md AGENTS.md docs/HOSTS.md docs/COLLABORATORS.md llms.txt .claude-plugin .codex-plugin .cursor-plugin .agents .github plugin.json
git commit -m "test: adopt environment selector distribution"
```

Stage only files actually changed by the reviewed stamper.

---

### Task 7: CP2 Live Exercise and Evidence Checkpoint

**Files:**
- Create: `docs/evidence/home-environments/2026-08-30-selector-live/README.md`
- Create: `docs/evidence/home-environments/2026-08-30-selector-live/rank-result.json`
- Create: `docs/evidence/home-environments/2026-08-30-selector-live/switch-result.json`
- Create: `docs/evidence/home-environments/2026-08-30-selector-live/tool-counts.json`

**Interfaces:**
- Consumes: built full-surface tool, current mission-table native run receipt, emulator-5554.
- Produces: exact live classification/action receipts and the CP2 commit/report evidence.

- [ ] **Step 1: Reverify emulator identity without touching the physical device**

Run explicit-serial read-only probes for online state, boot complete, product `swan`, model
`swan_arm64`, incremental `4399`, fingerprint, and boot ID. Abort on mismatch. Do not run any
unqualified adb command.

- [ ] **Step 2: Obtain a current receipt-bound bridge runtime**

If the CP1 receipt no longer binds the live PID/boot/APK, run `fleet_build` for `swanmissiontable`
to create a fresh receipt. LOOK at its capture only if making a visual claim; the switch exercise
itself remains structural.

- [ ] **Step 3: Exercise rank and guarded switch**

Call rank with `briefId: "swanmissiontable"` and confirm that the measured-potential
0.782631×0.464378 table gives both Livingroom Day and Livingroom Night approximately 0.774 scale,
with stable dataset order proposing Day. Call switch with exact serial, package, receipt, and Mixed
stage. Persist the complete structured results through `apply_patch`.

Require `selected_verified`, changed snapshots, unique `Livingroom Day` histogram classification,
matching preferred live TABLE extent after cluster validation, selected-dialog hash, post-click
WorldSpace context, and exact runtime identity. The refreshed evidence supplies no Day surface
guarantee: a current large FLOOR cannot substitute for the globally ranked preferred TABLE tier.
Any ambiguity stops CP3 with both fit predicates unevaluated and is reported, never overridden.

- [ ] **Step 4: Persist measured surface counts**

Capture installed-tarball `tools/list` evidence for macOS 252 and doors 18. Record the 249
other-host derivation from the existing three-tool platform delta. Include command output and data
shipping gate evidence in the README.

- [ ] **Step 5: Run CP2 gates again and commit**

Run build, test:bridge, doors, tarball, docsmeta, adoption-safety, and distribution-adoption, each
after build. Verify protected paths and version again. Then:

Commit the evidence as a temporary review checkpoint. After its task review is clean, consolidate
all post-CP1 planning, implementation, count-chain, and live-evidence checkpoints into one unpushed
CP2 commit named `feat: select and verify home environments`. Use a non-destructive index/worktree
preserving squash, verify the resulting tree is byte-identical to the reviewed Task 7 tree, and
record the final CP2 SHA in the ledger before beginning CP3.

---

### Task 8: CP3 Fresh TABLE Placement Proof

**Files:**
- Create: `docs/evidence/home-environments/2026-08-30-table-proof/README.md`
- Create: `docs/evidence/home-environments/2026-08-30-table-proof/environment-verification.json`
- Create: `docs/evidence/home-environments/2026-08-30-table-proof/dialog-monitor.log`
- Add: exact settled capture(s) that frame the TABLE placement.

**Interfaces:**
- Consumes: Livingroom Day uniquely verified with a preferred live TABLE and a newly generated
  mission-table run receipt.
- Produces: visual TABLE placement evidence, panel text, hashes, monitor proof, and CP3 commit.

- [ ] **Step 1: Confirm the environment remains uniquely Livingroom Day**

Run `select_home_environment` verify against the current receipt/baseline or repeat a guarded switch.
Do not proceed from the selected tile or Xiata scene ID alone.

- [ ] **Step 2: Launch the mission-table app fresh with a new receipt**

Run a fresh `fleet_build(["swanmissiontable"])` after the switch so receipt PID/start identity and
capture bind the new launch. Confirm the runtime remains on emulator-5554 and the physical device
was not addressed.

- [ ] **Step 3: Monitor 60 seconds for absent dialogs/ANR**

Poll the exact emulator for foreground/error-dialog state and ANR/crash logcat evidence for at least
60 continuous seconds. Save the timestamped log. Any ANR, error dialog, package crash, or physical
serial access fails CP3.

- [ ] **Step 4: Prove TABLE route structurally**

Query the bridge and panel/runtime telemetry. Require the panel's exact TABLE anchor line and reject
any `label_absent`, `FLOOR fallback`, or waiting route. Record the selected TABLE bounds and runtime
scale; compare against the expected approximately 0.774 fit.

- [ ] **Step 5: Capture settled framing and LOOK**

Use `capture_settled` with the fresh receipt. If the diorama is not framed on the table, use only
serial-bound camera controls, settle again, and retain the strongest capture. Open every claimed
image and write the eye verdict verbatim. Compute SHA-256 and byte size for each retained capture.
Do not claim table placement unless the looked-at frame visibly shows the diorama on the table at a
believable scale.

- [ ] **Step 6: Record verification honestly**

Call `record_verification` with `vision_verified` only after LOOK, linked to the exact fresh receipt
and capture. If the frame is inconclusive, retain structural evidence and report CP3 UNVERIFIED.

- [ ] **Step 7: Persist and commit CP3 evidence**

Use `apply_patch` for text evidence, force-add only the intentional ignored `.log`, run docsmeta, and
commit:

```bash
git add docs/evidence/home-environments/2026-08-30-table-proof
git add -f docs/evidence/home-environments/2026-08-30-table-proof/dialog-monitor.log
git commit -m "test: prove mission table placement on TABLE"
```

---

### Task 9: Final Verification and Branch-Only Push

**Files:**
- No new files unless a gate produces evidence explicitly required by Task 7 or 8.

**Interfaces:**
- Consumes: all CP1/CP2/CP3 commits.
- Produces: pushed `env-fit-selector-2026-08-29` branch and final report.

- [ ] **Step 1: Run the final required gates**

Run build; test:bridge; doors; tarball; docsmeta; adoption-safety; distribution-adoption; and any
additional owning suite for every changed file. Rebuild before each test command.

- [ ] **Step 2: Review exact final diff and invariants**

Verify clean worktree, version 37.0.0, 252/249/18 evidence, dataset tarball canary, no benchmark or
agentbench differences, no unintended stamped hunks, and only the two known distribution failures.

- [ ] **Step 3: Push only the feature branch**

Run:

```bash
git push -u origin env-fit-selector-2026-08-29
```

Never push `main` and do not create a release tag.

- [ ] **Step 4: Report complete evidence and remaining UNVERIFIED boundaries**

List every CP commit/path, the capability table, switch-detection citations, automation reliability,
implemented tool contract, measured counts, tarball dataset proof, live classification evidence,
TABLE-proof paths/SHA/panel text/verbatim eye verdict, gate totals, branch push, and every remaining
UNVERIFIED item.
