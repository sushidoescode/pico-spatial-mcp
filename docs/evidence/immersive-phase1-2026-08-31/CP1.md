# CP1 shared route and runtime-continuity substrate

Date: 2026-08-31

Branch: `immersive-phase1-2026-08-31`

Scope: Phase-1 Tasks 1 and 2 from the
[immersive boundary and navigation plan](../../superpowers/plans/2026-08-29-immersive-boundary-and-navigation.md)

Runtime access: none. CP1 did not select the emulator or physical serial
`2G0YC5ZF7Z056Q`.

## Outcome and commits

| Task | Commit | Result |
| --- | --- | --- |
| Shared bounded relative-camera route | `664b9a4` | One lower action core now serves route execution and the existing orbit/multiview adapters. Application-aware routes retain exact runtime binding, bounded grouped actions, release certainty, settled captures, continuity before/after each completed waypoint, partial failure evidence, and deterministic external paths. |
| Application continuity and bounded log collection | `08bcdeb` | Exact package/APK/boot/PID/start-tick/foreground sampling, authenticated BoundaryProbe V1 events, conservative watchdog parsing, and one owned bounded raw-log window are available to the Phase-1 orchestrator. |

Primary implementation and owning tests:

- `src/navigation.ts`, `src/cameradrive.ts`, `src/observation.ts`, and
  `test/navigation.mjs`
- `src/runtimecontinuity.ts`, `src/nativefleetreceipt.ts`, and
  `test/runtimecontinuity.mjs`
- Existing `test:emulator-restart` owns both new test files. No npm script key was added.

## Shared route contract

- The strict route binds one emulator serial, boot ID, gRPC discovery endpoint/qemu PID, optional
  exact qemu window, application identity, and reserved external artifact session before input.
- A waypoint is one bounded action group followed by a settled capture, with continuity sampled
  immediately before input and after settlement. Application-neutral callers must explicitly use
  `not_requested`; they cannot synthesize application facts.
- Per-action, cumulative, waypoint, duration, capture, finalization, and recovery reserves fail
  closed before movement. The route rechecks elapsed time after its pre-action continuity sample.
- Action failures retain prior receipts and the terminal attempt. Uncertain key release, identity
  loss, unsettled capture, budget exhaustion, and controller stop remain distinct typed outcomes.
- Existing `capture_orbit` and `capture_multiview` public schemas remain compatibility adapters over
  the same lower key/drag action owner.

## Continuity and raw-log contract

- One continuity sample is reserved 10,000 ms. Independent ADB observations run in two bounded
  waves with 4,000 ms child timeouts, the log reader is capped at 8,000 ms, and the overall work
  deadline is 9,000 ms. Cancellation prevents later dependency dispatch or parsing.
- Raw log normalization retains at most 65,536 lines and 64 MiB of UTF-8 text. Any excess is an
  explicit truncated/no-signal state; raw bytes remain in the external collector artifact.
- BoundaryProbe accepts only the Section 5.2 V1 schema and exact prefix. Sample aggregation also
  requires the exact `BoundaryProbe` threadtime tag and the currently observed positive app PID.
  Absent, malformed, truncated, gapped, wrong-session, and wrong-generation states remain explicit.
- Foreground classification reuses the receipt path's lossless parser without weakening its exact
  native-receipt policy. It recognizes the measured OS 6 co-resumed spatial shell only as the
  narrow exception defined by the plan; unlisted same-package components still fail identity.
- The collector owns exactly one `adb -s <serial> logcat -b all -v threadtime` child, streams no
  more than 64 MiB, records its PID/times/termination and marker observation, and tears down only
  that child with TERM then KILL. Confirmed and unconfirmed exits release local stream resources.
- Raw publication uses a same-directory exclusive hard link, no-follow descriptor open, bigint
  device/inode identity, exact regular-file mode and link counts, bounded descriptor reads, SHA-256,
  strict descriptor/temp cleanup, and a final sole-link check. A post-link verification failure
  never unlinks the target pathname because it may have been replaced.

## Evidence ceiling and captures

CP1 is structural implementation evidence only. It launched no app, moved no camera, and produced
no rendered capture. Therefore there is no CP1 capture path or SHA-256 and no visual, boundary,
ejection, or recovery claim. CP0's looked Claimsight and Welcome Space frames are not reused as
evidence for these code paths.

The implementation received independent spec-compliance and code-quality/security reviews. Final
review covered timing cancellation, tag/PID authentication, exact-child teardown, bounded memory,
symlink/repository escape rejection, no-clobber publication, target-swap handling, full mode
identity, and cleanup failures.

## Tool surface, deviations, and register

- No MCP tool or registration file changed. Doors remains 18; CP1 does not change the full-surface
  count. No tarball is required for this checkpoint.
- Package version remains 37.0.0; all 53 npm script keys are unchanged. The existing owning script's
  value was extended to include the new tests.
- `benchmarks/**` and `test/agentbench-*` remain byte-identical to base `8b0ed19`.
- There was no material design deviation. Descriptor/inode publication checks, cancellation, and
  teardown cleanup harden the plan's bounded ownership contract without expanding its tool/schema
  surface.
- U1, U2, and U18 remain open: CP1 provides the measurement substrate but made no live boundary or
  route observation. No other UNVERIFIED item is closed by structural code/tests alone.

## CP1 gates

Run from the branch worktree after a fresh build:

| Gate | Result |
| --- | --- |
| TypeScript build | PASS |
| Owning route/continuity suite | PASS; 120 cases total, including one expected Darwin-only skip |
| Native run-receipt regression suite | PASS, 215/215 |
| `test/docsmeta.mjs` | PASS, 0 failures; 120 relative links across 54 files (plus the known linked-worktree `.git/config` `ENOTDIR` warning) |
| `test/adoption-safety.mjs` | PASS, 48/0 |
| `test/distribution-adoption.mjs` | Expected baseline only, 41/2: the two known stale Linux-lane and suite-count assertions |
| Doors surface | PASS, 0 failures; exactly 18 tools |
