# Navigate to Scene Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the full-only `navigate_to_scene_target` tool with a trace-local two-color guide, bounded acquire/center/approach control, and a re-runnable same-guest/same-boot motion calibration receipt.

**Architecture:** Pure guide measurement, regression fitting, calibration validation, and controller transitions live in focused TypeScript modules. The live orchestrator composes the existing lossless scene query, exact runtime/window binding, `executeRelativeCameraRoute`, `executeBoundCameraActions`, `capture_settled`, and continuity sampling; it does not own another motion or settlement loop. Generated debug apps opt into a file-acknowledged Agent Bridge guide producer, and the Swan mission-table profile supplies the first concrete nested-corners guide on its already selected TABLE support.

**Tech Stack:** TypeScript, Zod, Node test runner, existing Python color-key detector, generated Kotlin/PICO Spatial SDK, MCP SDK.

**Spec:** `docs/superpowers/plans/2026-08-28-mr-agent-navigation-and-scene-understanding.md` §4.3, §5, roadmap row 3, Task 3, and its UNVERIFIED register.

## Global Constraints

- Start from `bc2ab58` on branch `navigate-scene-target-2026-09-01` in an isolated worktree.
- Reuse `src/observation.ts`, `src/cameradrive.ts`, `src/navigation.ts`, and `src/runtimecontinuity.ts`; do not duplicate their action, key-release, settled-capture, continuity, or route-budget loops.
- Every motion and guide transition is followed by `capture_settled`; an unsettled or stale-prior frame is never a waypoint.
- `executionStatus` is `completed | stopped | error`; achieved claims are independent members of `target_visible | target_centered | free_camera_approached`; no field says arrived, walked, pose, or device navigation.
- All target-navigation output and calibration receipts have `evidenceCeiling: "structural"` and explicit LOOK obligations. Emulator pixels never earn `device_verified` from this tool.
- Goal-directed approach refuses before camera input unless a validated calibration record matches exact serial, guest fingerprint/model, boot ID, qemu PID/window geometry, capture dimensions, camera-calibration bytes, bridge revision, guide pattern, and guide dimensions.
- A successful calibration receipt includes drag-pixels-to-yaw, drag-pixels-to-pitch, and hold-time-to-displacement fits plus sample residuals, RMSE, maximum absolute residual, and R-squared.
- The guide uses two actually distinct saturated RGB keys and `nested-corners-v1`; guide-off/on delta is mandatory.
- Full-surface count becomes 254 on measured macOS and 251 source-derived on Linux/Windows; Doors remains exactly 18.
- Keep package version `37.0.0`; add no npm script key; do not change `benchmarks/**` or `test/agentbench-*`.
- Live work occurs only in the final checkpoint. Before any live action, read-only probe the foreground/runtime; if a user app or unexpected state is foreground, stop without force-stopping, relaunching, selecting, or booting anything.

---

### Task 1: Fixture-driven guide math, calibration fits, and controller transitions

**Files:**
- Create: `src/navigationguide.ts`
- Create: `src/navigationcalibration.ts`
- Create: `test/navigationtarget.mjs`
- Create: `test/fixtures/navigation/guide-controller.v1.json`

**Interfaces:**
- Produces: `measureTwoColorGuide(frame, detections, fiducial)`, `fitThroughOrigin(samples)`, `calibrationQuality(fit, limits)`, `calibrationContextKey(context)`, `validateNavigationCalibration(record, context)`, and `decideNavigationStep(state, observation, calibration)`.
- Consumes: existing `analyzeColorKeys` output shape and no live dependencies.

- [ ] **Step 1: Write literal fixtures and failing guide-math tests**

  The JSON fixture must contain hand-derived frame dimensions, two per-color bounding boxes, combined bbox/center/area fraction, absent/duplicate/non-nested cases, centered/off-band cases, overshoot history, growing/shrinking area sequences, and expected actions/stops. Tests must name the production break they catch and assert literal results rather than values computed by implementation helpers.

- [ ] **Step 2: Build first, run the new test, and verify RED**

  Run `npm run build` before `node --test test/navigationtarget.mjs`. Expected failure: imports from `../dist/navigationguide.js` and `../dist/navigationcalibration.js` are missing.

- [ ] **Step 3: Implement minimal pure guide validation and measurement**

  `measureTwoColorGuide` must reject equal or neutral colors, require both detections, require outer-bbox containment plus bounded center skew for `nested-corners-v1`, union the two boxes, and return exact pixel center/error, bbox, width/height, and area fraction. It must never infer semantic identity from color.

- [ ] **Step 4: Verify guide tests GREEN**

  Run `npm run build` then `node --test test/navigationtarget.mjs`.

- [ ] **Step 5: Add failing regression-fit and calibration-validation tests**

  Use hand-computed samples such as `x=[-80,-40,40,80]`, `y=[-8,-4,4,8]` for a `0.1` slope and zero residual, plus noisy samples with literal expected RMSE/max residual. Mutations must cover wrong boot, guest, qemu/window, capture size, camera calibration hash, bridge revision, pattern, and guide dimensions.

- [ ] **Step 6: Implement regression and validation minimally, then verify GREEN**

  A fit has `{slope, sampleCount, residuals, rmse, maxAbsResidual, rSquared}`. Reject non-finite/degenerate samples, insufficient signed drag trials, non-positive forward displacement, or quality outside declared thresholds. Calibration context keys are SHA-256 of canonical identity fields, not path names or timestamps.

- [ ] **Step 7: Add failing controller-state tests, implement, and verify GREEN**

  Cover absent acquisition, horizontal-only search, center-band success, clamped yaw/pitch action, gain reduction after sign-changing overshoot, pitch guard, calibration-required approach, growing-area forward approach, two shrink observations, disappearance, target-area completion, action/time budget exhaustion, scene drift, and cleanup status. `decideNavigationStep` returns typed intent; it never executes input.

- [ ] **Step 8: Run CP1 gates and commit**

  Run fresh build; `test:emulator-restart` including the new file through the existing script value; docsmeta; adoption-safety; distribution-adoption (41/2 known-only); protected diff from `bc2ab58`. Commit source, fixture, test, plan, and the existing-script-value adoption without adding a script key.

### Task 2: File-acknowledged two-color guide protocol and generated mission-table producer

**Files:**
- Modify: `src/agentbridge.ts`
- Modify: `src/missiontable.ts`
- Modify: `src/assemble.ts`
- Modify: `appskeleton/app/src/main/java/com/example/spatialapp/agent/AgentBridge.kt`
- Modify: `test/sceneanchors.mjs`
- Modify: `test/conformance.mjs`
- Modify: `test/navigationtarget.mjs`

**Interfaces:**
- Consumes: Task 1 fiducial validation rules.
- Produces: versioned `navigation_guide` Agent Bridge request/ack transport and a mission-table producer that shows/hides a trace-local `nested-corners-v1` guide around the currently selected TABLE support.

- [ ] **Step 1: Write failing bridge transport and code-generation tests**

  Tests exercise a real fake adb transport: exact serial/package/request ID arguments, nonce-addressed app-private ack file, request/response echo of snapshot ID, target trace ID/runtime UUID, bridge revision, two colors, dimensions, pattern and mode, cleanup receipt, malformed/stale ack rejection, and no logcat geometry/ack fallback. Generator tests require guide code only in debug output and exact guide cleanup on hide/disposal.

- [ ] **Step 2: Build and verify RED**

  Run fresh build and the focused scene-anchor/conformance/navigation-target tests. Failure must be missing protocol behavior, not syntax.

- [ ] **Step 3: Implement Agent Bridge request/ack transport**

  Add a bounded file protocol parallel to scene snapshots. The app producer validates request identity, emits a strict JSON ack, and never treats an echoed snapshot ID as independent scene proof. The host adapter pulls through exact-serial `run-as`, validates every echoed field and bridge revision, cleans its own nonce file, and retains all action receipts.

- [ ] **Step 4: Implement mission-table guide producer**

  Add two connected nested rectangular guide frames from existing generated mesh/material primitives. Bind the request to the active TABLE anchor UUID and current support state, keep it disabled by default, update ECS only on the main dispatcher, and destroy/disable it on hide, target drift, stop, and scene disposal. The release build must exclude the authenticated debug command path.

- [ ] **Step 5: Verify focused suites GREEN**

  Run fresh build and `node --test test/navigationtarget.mjs test/sceneanchors.mjs`; run `npm run test:conformance`.

- [ ] **Step 6: Self-review generated Kotlin and commit**

  Generate Swan wiring twice and require byte-identical outputs. Confirm exact PICO entity-name grammar, resource close order, and absence of guide protocol from release output.

### Task 3: Calibration procedure, bounded navigation orchestration, and full-only tool

**Files:**
- Create: `src/navigationtarget.ts`
- Modify: `src/navigation.ts`
- Modify: `src/observation.ts`
- Modify: `src/cameradrive.ts`
- Modify: `src/index.ts`
- Modify: `test/navigation.mjs`
- Modify: `test/observation.mjs`
- Modify: `test/navigationtarget.mjs`

**Interfaces:**
- Consumes: Task 1 detector/fit/state interfaces; Task 2 guide bridge; `executeLiveQuerySceneAnchors`; `bindMacQemuWindow`; `createBoundCameraActionAdapter`; `executeRelativeCameraRoute`; `executeCaptureSettled`; application continuity sampling.
- Produces: `executeNavigateToSceneTarget(input, deps)` and `registerNavigationTargetTools(server)`.

- [ ] **Step 1: Write failing orchestration tests with complete fakes**

  Fakes mirror complete scene-query, qemu/runtime binding, continuity, action, settle, guide ack, detector, camera-calibration, filesystem, and monotonic-clock structures. Assert refusal before guide or input for scene/binding ambiguity and before approach input for missing/stale calibration; exact capture/action ordering; retained partial evidence; cleanup in every failure; independent achieved claims; structural ceiling; LOOK obligations; and no arrived/pose fields.

- [ ] **Step 2: Build and verify RED**

  Run fresh build then focused tests. Failure must be absent orchestration/export.

- [ ] **Step 3: Refactor only the shared seams needed by the orchestrator**

  Permit the existing route controller callback to be async so detector results can drive the next existing waypoint loop. Export a live settled-capture wrapper rather than recreating `defaultDependencies`. Extend qemu binding receipts with measured window bounds/scale needed to invalidate drag calibration. Preserve every current route/orbit/multiview schema and test.

- [ ] **Step 4: Implement the calibration action**

  Query/select target, capture guide-off, show/ack guide, settle, acquire if needed, then execute signed yaw/pitch drag trials and paired forward/back translation trials exclusively through the shared route. Derive angles from fresh camera intrinsics and guide center, derive depth/displacement from known guide dimensions, compute fits/residuals, hide guide, settle clean, write an external immutable receipt and the same-boot calibration registry record only when all quality gates pass.

- [ ] **Step 5: Implement the navigate action**

  Re-query and geometrically select `largest_horizontal`; enforce ambiguity separation and drift. Capture off/on; run acquire, center, and calibrated approach through async route decisions and shared budgets. Re-observe every settled waypoint. Re-query on divergence/guide loss. Conclude with a final settled diagnostic, hide acknowledgement, settled clean capture without backend input, `sameViewEvidence: "no_backend_action_requested"`, explicit LOOK obligations, and unconditional cleanup reporting.

- [ ] **Step 6: Register one full-only tool and verify owning suites GREEN**

  The MCP schema is discriminated by `action: "calibrate" | "navigate"`; the navigation branch implements the §4.3 input fields. Register only below `!doorsSurfaceActive()`. Run fresh build, navigation/observation/continuity suites, navigation-target tests, conformance, and Doors exactly 18.

- [ ] **Step 7: Run CP2 gates and commit**

  Run all per-checkpoint gates except tarball (count metadata changes in Task 4), then commit protocol/orchestrator/tool registration and tests.

### Task 4: Tool-count chain, synchronized metadata, documentation, and installed-tarball proof

**Files:**
- Modify: `scripts/verify-tarball.mjs`
- Modify: `scripts/sync-metadata.mjs`
- Modify: `test/distribution-adoption.mjs`
- Modify: `.claude/rules/release-invariants.md` only if its current-count prose requires synchronization
- Modify via `npm run sync:meta`: `README.md`, `GETTING_STARTED.md`, `TESTERS.md`, `QUICKSTART.md`, `SKILLS.md`, `AGENTS.md`, `docs/HOSTS.md`, `docs/COLLABORATORS.md`, `llms.txt`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Create: `docs/NAVIGATE_SCENE_TARGET.md`

**Interfaces:**
- Consumes: registered `navigate_to_scene_target`.
- Produces: exact full counts 254/251/18, tarball-required anchor assertion, and a re-runnable operator calibration guide.

- [ ] **Step 1: Write failing installed-surface/adoption assertions**

  Change literal expected counts to 254 macOS and 251 other-host source-derived, require `navigate_to_scene_target` in the full installed anchor list, keep both Doors assertions at 18, and update adoption expectations without accepting additional known failures.

- [ ] **Step 2: Verify RED against the unsynchronized chain**

  Run fresh build plus distribution-adoption and `sync:meta --check`; confirm only count/metadata drift caused the new failures.

- [ ] **Step 3: Update the load-bearing count sources and documentation**

  Preserve `const EXPECTED_TOOLS = <digits>` and the exact `// core lanes` comment. Add outgoing 253 to `PUBLISHED_COUNTS`. Document exact `calibrate`/`navigate` calls, validity bindings, residual fields, disabled-until-calibrated refusal, structural ceiling, cleanup, and LOOK obligations. Run `npm run sync:meta`; inspect every rewrite.

- [ ] **Step 4: Run CP3 gates including installed tarball and measured macOS tools/list**

  Fresh build; owning suites; docsmeta 0; adoption-safety 48/0; distribution-adoption 41/2 known-only; `npm run test:tarball` with full 254, source-derived 251, Doors 18, default 18; protected diff; version remains 37.0.0; npm script-key set unchanged.

- [ ] **Step 5: Commit and push only the feature branch**

  Commit metadata/docs/count proof. Push `navigate-scene-target-2026-09-01`, never `main`.

### Task 5: Final live calibration, acquisition, LOOK, and evidence checkpoint

**Files:**
- Create: `docs/evidence/navigate-scene-target-2026-09-01/FINAL.md`
- External only: full calibration/navigation receipts and ordered PNG captures under a private `/private/tmp` or `/tmp/pico-render` session root.

**Interfaces:**
- Consumes: installed/current worktree full-surface server and exact Swan mission-table build receipt.
- Produces: measured calibration fits/residuals, ordered capture paths/SHAs, one Livingroom TABLE acquisition trace, and honest UNVERIFIED updates.

- [ ] **Step 1: Perform the reservation safety probe**

  Read-only inspect exact online serial, boot ID, foreground/resumed application, qemu discovery/window, and emulator state. If a user app or unexpected foreground is present, stop and report; do not stop, relaunch, boot, select, or replace it.

- [ ] **Step 2: Run live camera and navigation calibration only now**

  Apply the doctor-named camera-calibration fix only if the safety probe is clear. Build/launch the debug Swan mission table, verify Livingroom TABLE presence, pause animation, run `navigate_to_scene_target {action:"calibrate",...}`, and retain the complete receipt even on failure. Open every calibration capture before accepting the fit.

- [ ] **Step 3: Run one bounded acquisition/centering/approach**

  Invoke `navigate` against the Livingroom large TABLE guide using the exact same-boot calibration. Retain ordered guide-off, guide-on, waypoint, final diagnostic, and final clean captures plus SHA-256. Stop on any unexpected foreground/binding/settle/drift state without force-stopping anything not launched in this checkpoint.

- [ ] **Step 4: LOOK and write the checkpoint**

  Open every returned frame. Record only visible bounded facts; keep tool evidence structural unless a separate valid `record_verification` call links an exact looked frame. Document commits/paths, calibration procedure/fits/residuals, count evidence, captures/SHAs, UNVERIFIED changes, gates, and deviations.

- [ ] **Step 5: Re-run final gates, commit evidence, and push feature branch**

  Run the complete CP3 gate set again after evidence documentation, commit only the lightweight Markdown checkpoint, and push only `navigate-scene-target-2026-09-01`.
