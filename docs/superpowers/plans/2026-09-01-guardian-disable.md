# Full-Immersive Guardian Disable Investigation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find and prove the least-invasive agent-drivable mechanism that disables the emulator safety boundary while a genuinely Full (`pico.spatial.stage.style=3`) Spatial SDK world remains immersive through the Phase-1 route, or stop at the exact privilege/signing/host wall.

**Architecture:** Reuse the existing `run_immersive_boundary_experiment` route and its immutable external evidence tree; do not add another MCP tool or a second movement/capture implementation. Investigate one control plane at a time, snapshot every candidate before and after, test the smallest reversible mutation, and run the Full route only after the effective guardian state is demonstrably off.

**Tech Stack:** TypeScript MCP server, Android/PICO OS 6 shell services, Spatial SDK 6.0/OpenXR sources, PICO emulator/QEMU, Node MCP stdio client, PNG/SHA-256 evidence, logcat.

**Spec:** `docs/evidence/immersive-phase1-2026-08-31/CP3.md` plus the 2026-09-01 guardian-disable reframe supplied by the user.

## Global Constraints

- Target only `emulator-5554`; never select or address physical serial `2G0YC5ZF7Z056Q`.
- O0 is blocking: do not run O1, O2, or O3 unless a genuinely Full boundary-disable mechanism is proved.
- `stage.style=1`/Mixed is not a disable mechanism and is excluded.
- Do not add MCP tools; stop and report before any public tool-surface change.
- Serialize all emulator operations in the owning controller; parallel work is host/source read-only.
- Every fresh launch receives a 60-second dialog monitor.
- Every route waypoint uses `capture_settled`; all heavy frames remain outside the repository.
- A visual claim requires human/model LOOK at the retained rendered frame; hashes alone are structural evidence.
- Any persistent device-state mutation must have an exact before value, verified after value, persistence scope, and tested revert command in the report.
- Tests import `dist/`; run `npm run build` before every owning test invocation.
- Required final gates: build; owning suites; `test:docsmeta` with zero failures; `test:adoption-safety` at 48/0; `test:distribution-adoption` at 41 pass / 2 known-only failures; no diff under `benchmarks/**` or `test/agentbench-*`.

---

### Task 1: Establish the current boundary owner and read-only control inventory

**Files:**
- Read: `docs/evidence/immersive-phase1-2026-08-31/CP3.md`
- Read: `src/boundaryexperiment.ts`
- Evidence outside repo: `/tmp/pico-guardian-disable-2026-09-01/recon/`

**Interfaces:**
- Consumes: exact emulator serial `emulator-5554` and the existing foreground app.
- Produces: a timestamped baseline containing foreground component, boot ID, `sys.guardian.vst.status`, related props, SELinux mode, package/service owners, settings namespaces, binder/cmd services, overlays, and PICO Settings activities.

- [ ] **Step 1: Run the default read-only doctor and preserve its exact failing checks.**

  Invoke existing `pico_doctor` with `{}` from the freshly built branch. Do not calibrate unless a later metric measurement requires it.

- [ ] **Step 2: Snapshot the emulator-only baseline.**

  Use only `adb -s emulator-5554` for `getprop`, `settings list`, `cmd -l`, `cmd overlay list`, `dumpsys package com.picovr.settings`, service/process ownership, and a bounded logcat baseline. Record permission-denied output verbatim.

- [ ] **Step 3: Enumerate guest-facing boundary controls without mutation.**

  Search setting keys/values, Settings resources/manifest/activity names, service help, overlay metadata, and readable system configuration for `guardian`, `boundary`, `safe`, `vst`, `seated`, `stationary`, and developer-mode vocabulary. Do not infer a toggle from a label alone.

### Task 2: Resolve SDK and host-side candidates before testing mutations

**Files:**
- Read: `/tmp/pico-immersive-phase1/cp0-samples/`
- Read: the on-disk Claimsight source/extract discovered by CP0
- Read: local SDK 6.0 declarations and vault/knowledge records
- Read: local emulator launch scripts, AVD configuration, and binary help/strings
- Evidence outside repo: `/tmp/pico-guardian-disable-2026-09-01/recon/`

**Interfaces:**
- Consumes: Task 1 inventory and Phase-1 source locations.
- Produces: a ranked candidate table with exact declaration/config path, required privilege, persistence, predicted observable, and safe revert.

- [ ] **Step 1: Distinguish boundary query/geometry APIs from disable APIs.**

  Require an exact callable, manifest key, or stage declaration that remains Full; APIs that merely return play-area geometry or change Mixed/Progressive presentation do not qualify.

- [ ] **Step 2: Inspect host launch/config controls.**

  Record exact QEMU/emulator flags, environment keys, AVD properties, and wrapper arguments. Treat binary strings as leads only until a real parser/config consumer is identified.

- [ ] **Step 3: Choose the least-invasive falsifiable candidate.**

  State one hypothesis in the form: “Changing X from A to B will make Y report off while Full remains foreground, because Z owns/consumes X.” Test only that variable.

### Task 3: Test one reversible disable candidate at a time

**Files:**
- Evidence outside repo: `/tmp/pico-guardian-disable-2026-09-01/candidates/<candidate-id>/`

**Interfaces:**
- Consumes: one ranked Task 2 candidate with an exact rollback.
- Produces: `effective`, `ineffective`, or `blocked`, backed by command output and before/after state.

- [ ] **Step 1: Capture the exact before state and define rollback.**

  Save the queried value, caller UID/domain where observable, emulator boot ID, and foreground component before mutation. If the original value cannot be recovered, do not mutate it.

- [ ] **Step 2: Apply the smallest authorized change.**

  Keep the serial explicit. Do not use `adb root`, remount, image resigning, physical-device provisioning, or a host restart unless the candidate specifically requires that wall to be characterized.

- [ ] **Step 3: Verify the write, its consumer, and its transition scope.**

  Read the value back immediately and across the relevant Full-stage transition. A successful command with an unchanged readback is a failure, not a disable.

- [ ] **Step 4: Revert failed candidates before continuing.**

  Execute the predeclared rollback and verify the exact original value. After three failed mutation hypotheses, stop mutation attempts and report the architectural/privilege wall.

### Task 4: Prove no ejection on the existing Full route, conditional on O0 success

**Files:**
- Reuse: `src/boundaryexperiment.ts`
- Reuse: `/tmp/pico-immersive-phase1/cp3/mcp-driver.mjs`
- Evidence outside repo: `/tmp/pico-guardian-disable-2026-09-01/proof/`

**Interfaces:**
- Consumes: an effective Task 3 disable with the off state verified.
- Produces: ordered Full-route captures, SHA-256s, route/identity receipts, a 60-second fresh-launch monitor, and a bounded logcat interval proving absence of the prior home/boundary transition signature.

- [ ] **Step 1: Start the Full route only after rechecking the off state.**

  Use F1 first because CP3 brackets its prior ejection between the authored 1 m and 2 m gates. Bind the exact serial, boot, APK, PID/start ticks, allowed component, and immutable route SHA.

- [ ] **Step 2: Monitor the fresh launch for 60 seconds.**

  Retain observations and settled frames at 0/30/60 seconds and inspect every returned frame for dialogs before movement.

- [ ] **Step 3: Walk the canonical 1/2/4/8/16/32 m authored gates.**

  Use the existing route action bytes. Require a settled capture at every ordered waypoint; a timeout or binding loss is not a successful waypoint.

- [ ] **Step 4: Inspect every frame and bracket logcat.**

  LOOK at every retained PNG. Confirm Full-world sentinels remain present and home pixels do not replace them. Search the exact route interval for `setSpatialContainerBoundary`, `container info changed`, boundary min/max changes, home transition, process restart, binding loss, crash, and ANR; report exact counts including zero.

- [ ] **Step 5: Verify the disable state after the terminal gate.**

  Re-read the effective flag/setting after the stage transition and route. If it reverted, the proof fails.

### Task 5: Conditional follow-ups, report, and gates

**Files:**
- Modify: `docs/evidence/guardian-disable-2026-09-01/O0.md`
- Conditionally modify only if evidence disproves a tracked statement: `README.md`, `DESIGN.md`, `docs/ANSWERED_BY_MEASUREMENT.md`, and the applicable design-register entries
- Test: owning suites for every changed source file

**Interfaces:**
- Consumes: Tasks 1–4 evidence and the O0 stop condition.
- Produces: the exact mechanism or wall; U1/U2/U18/U19 status; O1/O2/O3 status; revert instructions; gate output; a pushed feature branch only.

- [ ] **Step 1: Stop after O0 if no effective agent-drivable disable exists.**

  Mark O1/O2/O3 `not run (O0 blocked)` and document whether the remaining path requires a manual host click, system UID/signature permission, writable/eng image, image resigning, or emulator vendor support.

- [ ] **Step 2: If O0 succeeds, run O1/O2/O3 in order.**

  Run F2 dynamic Full; rerun the previously ejecting F1 and E1 routes; then walk the external Polyfork GLB world end to end. Keep licensed asset bytes and heavy frames outside the repo.

- [ ] **Step 3: Write the evidence report without overclaiming.**

  Include before/after flags, precise commands and privilege result, all capture paths/SHA-256s and LOOK outcomes, logcat interval/counts, agent-drivability, persistence/revert, O1/O2/O3, U1/U2/U18/U19, gates, and deviations.

- [ ] **Step 4: Run verification from rebuilt `dist/`.**

  Run `npm run build`, every owning suite, `npm run test:docsmeta`, `npm run test:adoption-safety`, and `npm run test:distribution-adoption`. Confirm `git diff --exit-code bc2ab58 -- benchmarks 'test/agentbench-*'` and inspect the final diff.

- [ ] **Step 5: Commit and push only `guardian-disable-2026-09-01`.**

  Verify `git branch --show-current` immediately before push; never update or push `main`.
