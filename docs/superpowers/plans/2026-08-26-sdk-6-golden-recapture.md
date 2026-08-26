# Spatial SDK 6.0.0 Golden Recapture Plan

> **DESIGN ONLY:** Do not execute this plan in the gate-hardening wave. A later, separately
> authorized wave must perform every emulator, build, capture, LOOK, baseline-write, and evidence
> step below.

**Goal:** Refresh the deterministic scorecard and reproducibility lock only after a Spatial SDK
6.0.0 scaffold has produced a rendered frame that a person or vision-capable agent inspected.

**Architecture:** Treat scorecard generation and rendered-frame acceptance as separate lanes.
`regression_gate` save mode runs the headless `computeSuite`, derives the SDK version from the
checked-in scaffold catalog, and writes the two repository baselines. A separate full-surface MCP
session builds the candidate app, restores a named emulator snapshot, captures an external evidence
image, and requires a LOOK before save mode records that snapshot and pose in the lock.

**Tracked output boundary:** The future recapture commit may modify only
`golden/scorecard.json` and `repro.lock.json`. Captures stay outside the repository. The tracked
`golden/showcase-6cards.golden.png` does not change under this plan; replacing that image requires
separate authorization.

## Repository-derived behavior

### What save mode actually needs

`src/gate.ts:75-100` calls `computeSuite(briefsDir)` before reading the build matrix. On success it
writes `golden/scorecard.json`, then writes `repro.lock.json`. It does not build, install, launch,
boot, restore a snapshot, move a camera, capture a frame, compare pixels, or write a verification
ledger.

`src/eval.ts:46-78` establishes the complete save-mode compute path:

- The supplied briefs directory must be readable. Its sorted `*.json` files form the corpus.
- Each JSON file is read and parsed, classified, schema-checked, linted, passed to the pure
  `buildLedger(spec, "/tmp/eval-dummy")` planner, and evaluated by `emulatorVsSwanPreview`.
- A malformed individual entry becomes a failed scorecard row; an unreadable briefs directory is
  the suite-level error.
- Per-app evidence ledgers are optional. A missing or unreadable ledger is caught and contributes
  zero evidence counts. To prevent machine-local evidence from changing the regenerated scorecard,
  the future run must set `PICO_MCP_LEDGER_DIR` to a new, empty directory outside the repository.
- The build matrix reads
  `appskeleton/gradle/libs.versions.toml` and `appskeleton/app/build.gradle.kts`
  (`src/buildmatrix.ts:7-29`). Both must be readable, and save mode requires a non-null parsed BOM.
  Requiring that value to equal `6.0.0` is this recapture plan's acceptance rule; the tool itself
  accepts any non-null version string.
- Save mode needs a writable source checkout for `golden/scorecard.json` and `repro.lock.json`.
  It refuses an installed-package location (`src/gate.ts:28-39`).

Therefore the save call itself needs no PICO SDK payload, emulator, AVD, adb, Android SDK, JDK,
Gradle execution, ImageMagick, network, device, or image. Those belong only to the visual lane.

### What the visual lane actually needs

The candidate visual route is the committed `showcase` brief because it declares six shelf cards
and a forward pose (`briefs/showcase.json:1-103`), while the existing PNG is named
`showcase-6cards.golden.png`. The repository contains no explicit provenance link between them, so
that association is **UNVERIFIED**. A future operator must confirm it before building; otherwise
stop and obtain the correct brief-to-image mapping.

For a confirmed `showcase` route, `fleet_build` (`src/fleetbuild.ts:879-895,1121-1216`):

1. scaffolds a project from the shared catalog;
2. generates the planned files;
3. runs exactly `:app:assembleDebug` through the Gradle wrapper;
4. installs and launches `com.fleet.showcase` on `emulator-5554`;
5. waits the requested settle period; and
6. returns an immutable native-run receipt and capture that still requires a LOOK.

`snapshot_save` and `snapshot_load` issue adb emulator snapshot commands
(`src/agentloop.ts:53-81`). `capture_frame` writes a full-resolution adb screencap and returns an
image for inspection (`src/capture.ts:32-68`). `regression_gate` check mode uses ImageMagick to
resize and compare supplied frame pairs (`src/gate.ts:44-54,115-149`); its numeric result assists
the visual decision but does not replace it.

## Prerequisite inventory

Every row marked **UNVERIFIED** must be checked on the future capture machine. Repository source or
committed static artifacts cannot establish that machine state.

| Prerequisite | Required by | Status and acceptance check |
| --- | --- | --- |
| Clean source checkout at the orchestrator-approved recapture base, on only the intended recapture branch | both lanes | **UNVERIFIED until the future run.** Verify with `git status --short --branch` and `git rev-parse HEAD`; stop if the starting tree has any tracked or untracked change. |
| Node.js 20 or newer, installed dependencies, and freshly built `dist/` | both lanes | **UNVERIFIED on the future machine.** Repository source declares Node `>=20`; run `node --version`, `npm ci`, then `npm run build` before starting the server. |
| Full MCP surface | all named low-level tools | Registration is repository-verified; successful future startup is **UNVERIFIED** until run. Start `node dist/index.js` with `PICO_MCP_SURFACE=full`; `regression_gate` is registered only inside the full-surface branch (`src/index.ts:215-319`). |
| Fresh empty external ledger and receipt directories | reproducible scorecard and parent-server evidence | **UNVERIFIED until created.** Create a session directory with `mktemp -d`; set `PICO_MCP_LEDGER_DIR` and `PICO_MCP_RUN_RECEIPT_DIR` below it before server start. Do not place either in the checkout. Audit the separate `fleet_build` child behavior described below. |
| No user-store `showcase.json` shadow | corpus-bound visual candidate | **UNVERIFIED and blocking.** `findBriefPath` checks the user store before the committed corpus (`src/briefstore.ts:34-40`). Require the user-store path to be absent; do not rename, delete, or overwrite it as part of recapture. |
| Fresh generated-project directory below the session root | scaffold provenance | **UNVERIFIED until created.** The session root comes from `mktemp -d`. Require its `projects/fleet-showcase-native` target not to exist, explicitly scaffold it during this session, and byte-compare its catalog with the source catalog before `fleet_build` reuses it (`src/fleetbuild.ts:959-974`). |
| Readable `briefs/`, scaffold catalog, and app Gradle file; writable `golden/` and repo root | save lane | **UNVERIFIED on the future checkout.** Verify ordinary file access. Missing catalog/BOM must return the clean refusal and write neither output. |
| Exact regenerated scorecard values for the current 26-file corpus | save lane | **UNVERIFIED.** Do not predict or hand-author them; accept only `computeSuite` output and review every failed/skipped row. |
| Resolvable Spatial SDK 6.0.0 BOM, the six PICO modules declared by the scaffold, its Android/Compose dependencies, and the Gradle distribution | native build | **UNVERIFIED.** Cached 6.0.0 artifacts are documented, but the repo does not prove that the future machine has the complete cache or network access. The build must show successful resolution and `:app:assembleDebug`. The scaffold declares no PICO-specific Gradle plugin. |
| PICO emulator payload compatible with the 6.0.0 scaffold, including executable emulator tooling and accepted license | emulator | **UNVERIFIED.** Use read-only `pico_doctor {}` and `validate_toolchain {}` to inspect the relevant fields. Require the selected emulator payload, license, AVD, adb, and JDK checks needed by this route; unrelated warnings do not block it. The catalog version alone does not establish payload compatibility. |
| Android SDK/build tools, an explicitly selected adb, and a JDK usable by the Gradle wrapper | build, install, capture | **UNVERIFIED and blocking.** `pico_doctor {}` and `validate_toolchain {}` must resolve them. Export the report's exact SDK-6-compatible adb path as `PICO_ADB` and prepend its directory to `PATH` before the execution server starts; this binds both direct capture/build consumers and shared adb helpers to one binary. `fleet_build` must then prove build/install/launch success. |
| A PICO AVD that boots to `emulator-5554` and is compatible with the selected SDK/emulator payload | runtime | **UNVERIFIED.** Confirm with `pico_emulator {"action":"status"}`; if absent, boot and require completed Android state before building. |
| ImageMagick `magick` | automated eye and frame comparison | **UNVERIFIED.** Require successful version probe. `sips` is optional because `capture_frame` falls back to returning the full image. |
| Named snapshot `sdk-6-showcase-golden-v1` containing the launched app at the accepted scene state | repeatability | **UNVERIFIED** until created, loaded, and followed by a successful fresh capture. The current lock names no snapshot. |
| Exact absolute yaw `0` / pitch `0` establishment | lock accuracy | **UNVERIFIED and blocking under this plan's policy.** The brief declares these degrees, but `emulator_look` accepts relative pixel drags, not absolute angles. `capture_canonical {"recenter":true}` reports its rendered-pose effect as unverified. The gate does not validate supplied coordinates; the future operator must establish them before save. |
| Existing PNG provenance and its association with `briefs/showcase.json` | comparison meaning | **UNVERIFIED and blocking.** Confirm from external capture records or the original author; filename similarity is insufficient proof. |
| Expected visual differences under SDK 6.0.0 | visual acceptance | **UNVERIFIED.** The drift measurement identifies design-token risk but contains no rendered 6.0.0 observation. Every changed frame must be looked at and judged on its actual pixels. |
| Capture retention location and reviewer identity | audit trail | **UNVERIFIED.** Choose an external durable location and named reviewer before capture; `/tmp` is only suitable as a working copy. |

## Exact future execution route

These steps are ordered. A failed or **UNVERIFIED and blocking** prerequisite stops the run; it is
not bypassed by writing the baselines directly.

### 1. Prepare an isolated source session

From the future recapture checkout:

```bash
git status --short --branch
git rev-parse HEAD
node --version
npm ci
npm run build
REPO_ROOT="$(pwd -P)"
SESSION_ROOT="$(mktemp -d /tmp/pico-sdk-6-golden-recapture.XXXXXX)"
export PICO_MCP_SURFACE=full
export PICO_MCP_LEDGER_DIR="$SESSION_ROOT/ledgers"
export PICO_MCP_RUN_RECEIPT_DIR="$SESSION_ROOT/run-receipts"
export PICO_MCP_NO_AUTOBRIDGE=1
node dist/index.js
```

The final command is the stdio server command for a connected MCP client, not an interactive shell
prompt. Record the resolved checkout path and `SESSION_ROOT` in the external run notes.

### 2. Run read-only preflight through that server

Call, in order:

```json
{"tool":"pico_doctor","arguments":{}}
{"tool":"validate_toolchain","arguments":{}}
{"tool":"build_matrix_report","arguments":{}}
{"tool":"pico_emulator","arguments":{"action":"status"}}
```

Require the matrix report's `observed.bom` to equal `6.0.0`. Record the resolved dependency,
toolchain, JDK, adb, AVD, and emulator facts. Stop this discovery server, export the report's exact
absolute adb path as `PICO_ADB`, prepend `dirname "$PICO_ADB"` to `PATH`, and restart
`node dist/index.js` with the other session variables unchanged. Repeat `validate_toolchain {}` and
require its `adb` field to equal `PICO_ADB`. All later tool calls use that restarted server. If the
emulator is not running, first resolve the
**UNVERIFIED** compatible tool-version label and AVD name, then call `emulator_boot` with those exact
values, `headless: true`, `wipeData: false`, `bootTimeoutSec: 240`, and `extraArgs: []`. Repeat the
status call and require `emulator-5554` plus completed Android boot. Do not use the default-selection
boot route until the selected payload/AVD compatibility is established. Do not run any calibration
workflow; the plan needs rendered-frame inspection, not metric placement evidence.

Before the build call, verify that the user store cannot shadow the committed corpus and that the
fleet target is fresh:

```bash
test ! -e "$HOME/.pico-mcp/briefs/showcase.json"
test ! -e "$SESSION_ROOT/projects/fleet-showcase-native"
```

If either check fails, stop. Do not remove a user's brief or reuse/delete an existing generated
project to force the run through.

### 3. Build the candidate and inspect the receipt-bound capture

Only after the old-PNG association has been confirmed, explicitly scaffold the fresh fleet target:

```json
{
  "tool": "scaffold_spatial_app",
  "arguments": {
    "targetDir": "/absolute/session/root/projects/fleet-showcase-native",
    "packageName": "com.fleet.showcase",
    "appName": "FleetShowcase",
    "stageStyle": "3"
  }
}
```

Replace `/absolute/session/root` with the exact resolved `SESSION_ROOT`, require the response's
`created` path to equal the requested target, then bind the generated catalog to the source
checkout before any native build:

```bash
cmp "$REPO_ROOT/appskeleton/gradle/libs.versions.toml" \
  "$SESSION_ROOT/projects/fleet-showcase-native/gradle/libs.versions.toml"
rg -n '^bom = "6\.0\.0"$' \
  "$SESSION_ROOT/projects/fleet-showcase-native/gradle/libs.versions.toml"
```

Both commands must exit zero. Now call:

```json
{
  "tool": "fleet_build",
  "arguments": {
    "briefIds": ["showcase"],
    "projectsRoot": "/absolute/session/root/projects",
    "settleSec": 12
  }
}
```

Replace `/absolute/session/root` with the exact resolved `SESSION_ROOT` created in Step 1. Because
that root is new and the user-store shadow check passed, `fleet_build` reads the committed
`briefs/showcase.json` and reuses only the current-session project whose catalog bytes were just
bound to the source checkout.

Require the top-level status to be `ok`; require `built` and `installed` to be true and
`receipt.status` to be `recorded` for `com.fleet.showcase`. Treat `concluded` as proof only that the
automated judge returned a verdict, not that the pixels passed. Open the exact returned receipt
capture and LOOK at it. Record its absolute path, SHA-256, receipt ID, SDK/build logs, emulator
identity, time, automated verdict, and a concrete description of what is actually visible.
Automated measurements alone are insufficient.

`fleet_build` starts an internal full-surface server with a restricted inherited environment
(`src/fleetbuild.ts:634-649`). That child does not inherit `PICO_MCP_LEDGER_DIR`; a confident
automated visual result can therefore append to the default external ledger even though the parent
server uses the session directory. Record the returned `visualLedger` result and sequence so this
side effect can be audited or corrected during rollback. It does not affect the isolated
`computeSuite` scorecard run.

### 4. Establish and prove the reproducible state

First resolve the blocking absolute-pose prerequisite. Once yaw `0` / pitch `0` and the intended
showcase state are externally confirmed, call:

```json
{"tool":"snapshot_save","arguments":{"name":"sdk-6-showcase-golden-v1","serial":"emulator-5554"}}
{"tool":"snapshot_load","arguments":{"name":"sdk-6-showcase-golden-v1","serial":"emulator-5554"}}
{"tool":"emulator_status","arguments":{"serial":"emulator-5554"}}
{"tool":"check_crash","arguments":{"serial":"emulator-5554","packageName":"com.fleet.showcase","lines":500}}
{"tool":"capture_frame","arguments":{"serial":"emulator-5554","outPath":"/tmp/pico-sdk-6-showcase-after-restore.png","maxDim":1200}}
```

After `snapshot_load`, poll `emulator_status` until it reports `emulator-5554` running with
`sys.boot_completed` equal to `1`, or stop after the same 240-second boot budget. Then require
`check_crash` to show `com.fleet.showcase` alive with no crash finding before capture. The snapshot
tool itself performs no readiness wait. LOOK at the exact restored-state capture. Confirm the intended six-card view,
absence of obvious rendering defects, and agreement with the state described for the receipt
capture. `capture_frame` does not return a hash, so record one explicitly:

```bash
shasum -a 256 /tmp/pico-sdk-6-showcase-after-restore.png
```

A snapshot command's success text is not visual evidence. This pose/snapshot/readiness/LOOK ordering
is future-operator policy: save mode merely persists the supplied strings and numbers and cannot
validate any of it.

Compare the restored-state capture with the committed image by calling `regression_gate` check
with the resolved absolute checkout paths:

```json
{
  "tool": "regression_gate",
  "arguments": {
    "mode": "check",
    "briefsDir": "/absolute/source/checkout/briefs",
    "frames": [
      {
        "name": "showcase-6cards-sdk-6-candidate",
        "golden": "/absolute/source/checkout/golden/showcase-6cards.golden.png",
        "fresh": "/tmp/pico-sdk-6-showcase-after-restore.png"
      }
    ]
  }
}
```

Replace `/absolute/source/checkout` with the recorded absolute checkout path before calling the
tool. `CHANGED` requires a visual decision; `IDENTICAL` still requires the already-completed LOOK.
Under this plan's stricter operator policy, `MISSING` or `UNKNOWN` is a failed comparison lane and
blocks baseline saving. The gate implementation does not independently block those two results.
Before save, also require `status: "ok"`, `blocked: false`, a verdict of `PASS` or visually accepted
`LOOK`, an empty `scorecard.regressedBriefs`, and `scorecard.scoreDrop: false`. Review any non-null
`stepDrift`. A `BLOCK` response is never overwritten by save mode.

### 5. Write the two baselines and exercise the derivation

After visual acceptance, call save exactly once:

```json
{
  "tool": "regression_gate",
  "arguments": {
    "mode": "save",
    "briefsDir": "/absolute/source/checkout/briefs",
    "canonicalPose": {"yawDeg": 0, "pitchDeg": 0},
    "goldenAvdSnapshot": "sdk-6-showcase-golden-v1"
  }
}
```

This call exercises the derivation at `src/gate.ts:83-99`: `extractBuildMatrix()` reads the
catalog and supplies `observed.bom`; no caller supplies `sdkVersion`. Require all of the following:

- status is `saved`;
- the returned paths resolve to `golden/scorecard.json` and `repro.lock.json` in this source
  checkout;
- `repro.lock.json.sdkVersion` is exactly `6.0.0`;
- `repro.lock.json.canonicalPose` and `goldenAvdSnapshot` exactly match the proven state;
- every scorecard failure or skip is reviewed rather than normalized away; and
- `git status --short` shows exactly those two modified tracked paths and no staged or untracked
  path; `git diff --name-only HEAD -- golden/scorecard.json repro.lock.json` shows both files.

Run `regression_gate` check once more with the same frame pair as a diagnostic. Because the tracked
PNG remains the older baseline, an accepted SDK-driven pixel change will continue to produce
`LOOK`; that second check does not create or validate a new visual PNG baseline. Replacing the PNG
would need separate authorization. Then run the repository-required build and tests for that future
wave, always rebuilding `dist/` before tests.

Only after save, the diagnostic check, and scorecard review may durable manual evidence be written.
Call `record_verification` with `app: "com.fleet.showcase"`,
`claim: "6 shelf cards render in the forward FOV"`, `evidenceType: "vision_verified"`,
`artifactPath` set to the exact receipt-bound capture, `runReceiptId` set to that capture's exact
receipt ID, and an observation-specific `attestation`. Do not bind the later restored-state capture
to the earlier receipt. Keeping this write after save prevents manual evidence from influencing
`computeSuite` totals.

## Required acceptance evidence

The future change is not complete until its report contains:

- source commit, catalog BOM, dependency/build result, emulator/AVD identity, snapshot name,
  canonical-pose method, and tool-call outputs;
- the receipt-bound capture path, hash, and receipt ID;
- the restored-snapshot capture path and hash;
- a named reviewer or vision-capable agent's description of what was seen in both exact images;
- the old/new image pair plus the MAE assist result, with any SDK-driven visual difference
  explicitly accepted or rejected after inspection;
- the generated scorecard totals and row review;
- the `repro.lock.json` diff showing catalog-derived `sdkVersion: "6.0.0"`; and
- a two-path diff proving no other tracked file changed.

The static drift report is supporting risk context only. It cannot substitute for the rendered
captures or their LOOK.

## Rollback

Before save mode, preserve `git status --short` and copies of the two tracked baselines outside the
checkout. If the future recapture is rejected before commit, restore only the two authorized files:

```bash
git restore --source=HEAD -- golden/scorecard.json repro.lock.json
```

If the baseline update was committed, create a new revert commit for that recapture commit; do not
rewrite shared history. Retain rejected captures, generated-project logs, and run notes as external
audit evidence. Snapshot, generated project, receipt, and evidence-store changes are external state:
load the previously recorded snapshot if one exists, archive the generated project outside the
checkout, and correct an evidence entry through the repository's append-only correction route
rather than deleting history. The existence and name of any prior usable snapshot are
**UNVERIFIED** because the current lock records `null`.
