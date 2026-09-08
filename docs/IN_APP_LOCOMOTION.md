# Receipt-bound in-app locomotion

`run_in_app_locomotion_route` is a full-surface-only, receipt-bound route
orchestrator for a PICO Spatial Full stage. Its contract is deliberately
staged: `prepare` → reviewed `step` calls → `restore` → `adjudicate`. It binds
the exact native run receipt, APK hash, serial, runtime context, safety state,
and external artifact root before it accepts a route.

On macOS, preparation and distance measurements require the bound qemu window
to be visible and unoccluded. Receipts include the host window probes;
`host_window_occluded` names overlapping window owners. Missing visibility
evidence fails closed. See [Space Program receipts](SPACE_PROGRAM_RECEIPTS.md)
for probe semantics and retained settled pairs.

The [CP2 live regression](evidence/in-app-locomotion-cp2-2026-09-05/CP2.md)
records positive product-route evidence through a generated Boundary Lab Full
world at protocol-absolute `AgentWorldRoot` targets `0/1/2/4/8/16 m` on
`emulator-5554`. Every settled
frame was LOOKed, every accepted baseline/waypoint HMD sample was
`(0,1.65,0)`—tracking-origin `x/z` with the provider's `1.65 m` eye-height
`y`—with `0 m` measured translation drift, Guardian remained active, and no
ejection occurred. Direct glide also returned to the byte-exact zero baseline.
Replacement matched every nonzero endpoint but its settled restore frame did
not match baseline despite a local root-position readback of `(0,0,0)`, so
replacement rendered-zero restoration and fallback status are **UNVERIFIED**. The retained
bytes do not prove that the complete detailed
released-state probe preceded the earliest build/install mutation, so the
strict staged-entry chronology remains **UNVERIFIED**; a later same-boot
snapshot matched the released state before the structurally completed
replacement route,
and each product route enforced its own clean Full safety preflight before
movement. The historical
[L0 spike](evidence/locomotion-spike-2026-09-02/L0.md) remains the feasibility
predecessor rather than the current product proof.

That live evidence is bound to branch head `d1435ef`. Later server-only
deadline, restoration, action-publication, and prepare-clearance hardening at
`07b6366` was exercised against rebuilt fakes after the emulator was released.
No post-live emulator rerun occurred, so those later orchestration changes do
not broaden the rendered-frame conclusion.

## Surface and input

Register with `PICO_MCP_SURFACE=full`; the Doors surface does not expose this
tool. The input is one strict union with exactly these actions:

| Action | Required review/input |
| --- | --- |
| `prepare` | Exact serial; Full-stage scenario (`stageStyle: "3"`, `rootContainer: "stage"`); native run receipt provenance; explicit mechanism; contiguous absolute waypoints; zero absolute restore target; capture policy; duration/route/restoration budgets; prior-foreground declaration; external artifact root. |
| `step` | The prepared `runId`, one exact route waypoint, and a `reviewedPriorFrame` containing the retained capture SHA-256 and a LOOK attestation. |
| `restore` | The prepared `runId` and the exact reviewed current frame. |
| `adjudicate` | The prepared `runId` and attestations for the complete exact retained required-review set: baseline, waypoints, and any distinct recovery frame. |

The prepare schema pins `translationDriftThresholdM` to the literal `0.02`.
It does not accept a physical-walk input. Waypoints are absolute, finite,
Float32-bound targets with contiguous sequence numbers; the restore target is
exactly `{ "absolute": true, "x": 0, "y": 0, "z": 0 }`.

## Mechanism selection

Prepare must select exactly one mechanism: `direct` or `replacement`. The
selection is explicit and receipt-checked; the route never silently falls back
or switches mechanism. `replacement` requires `route.glideDurationMs: 0`.
Choose the mechanism required by the experiment or producer contract and keep
that choice consistent through the route and restoration receipts.

CP2 compared `direct` and `replacement` with matched cold-launch routes on the
same boot: receipt, APK, absolute targets, budgets, and capture policy matched,
while the explicit mechanism and its required glide duration differed. Both
produced the same byte-exact baseline and ordered `1/2/4/8/16 m` waypoint
frames and passed safety, continuity, and waypoint HMD freshness/drift gates;
every retained frame was LOOKed. Direct restoration was byte-identical to
baseline. Replacement's
structural acknowledgement reported local root position `(0,0,0)`, but its
settled rendered frame differed from baseline.

Applying the approved selection rule, **direct only passes** and is the default:
it preserves root identity and uses the requested glide duration. Replacement
is not a rendered-frame-proven fallback. Its explicit mode remains useful as an
experimental evidence surface, but a route requiring proven zero restoration
must not select it from this evidence. The input remains explicit; the tool
never silently switches mechanisms if direct fails.

The CP2 forensics refute an early/incompletely loaded baseline: the last logged
model addition preceded each of two byte-identical cold baselines by more than
66 seconds; retained scene/sprite log-tag message counts stopped increasing by
the 30-second monitor sample and remained unchanged at 45 and 60 seconds;
direct still returned to that hash more than seven minutes after its last
logged launch-time model addition; and replacement reparents launch-created
children rather than rebuilding Boundary Lab. Generated enclosure, gate, and
panel content is authored beneath `AgentWorldRoot`, refuting an intentional
out-of-root side-gate path. Runtime descendant ancestry was not independently
censused. The remaining receipt gap is transform space: the acknowledgement
reads a local `TransformComponent`; it contains no composed/world-space or
renderer readback. Restore also sampled no fresh HMD pose. The exact residual
native/view-origin, descendant-reparent, compositor, runtime-parenting, or
unobserved head-pose cause is therefore **UNVERIFIED**, while the failed
rendered-zero proof is definitive.

## Evidence contract

Every action returns a structural receipt. Successful or otherwise
review-bearing `prepare`, `step`, and `restore` outcomes return retained
captures with `evidenceCeiling: "structural"`; a failure before a trustworthy
capture can return an empty review set. Returned captures still require a
human LOOK. A
structurally completed route, a `restored_needs_review` result, or an
`adjudicate` response does not itself award `vision_verified` or
`device_verified` evidence. Any visual/device claim must use the repository's
separate evidence workflow with the exact returned capture.

Two guest-side read commands can supplement that evidence:

- `adb shell getprop sys.guardian.vst.status`
- `adb shell dumpsys ConfigurationService` — inspect `spatial_stage_style`,
  `spatial_safeguard_enable`, `spatial_safeguard_center`, and
  `spatial_virtual_content_detected`.

`spatial_stage_style` reads the SHELL's stage (`2`) unless the app under test is resumed.

The review order is part of the contract:

1. LOOK at the baseline capture returned by `prepare` and submit its exact
   SHA-256 as the reviewed prior frame.
2. For each waypoint, LOOK at the returned settled capture before authorizing
   the next step.
3. LOOK at the current route frame before `restore`. If a failed restore
   returns a newer recovery frame, LOOK at that exact frame before retrying.
4. Submit attestations for the complete exact required-review set to
   `adjudicate`.

Waypoint captures and moved-state recovery captures explicitly use semantic
`transition_then_stable` settlement: the SHA must first differ from the prior
frame, then the tool requires a byte-identical stable pair. Baseline and
already-zero recovery captures use ordinary `stable` settlement. This is a
temporal settlement rule, not visual proof, and it does not encode a fixed
renderer-delay guarantee. In CP2, waypoint transitions were first observed
3.265–5.021 seconds after the stable guest acknowledgement and settled in
4.535–6.302 seconds. One replacement restore began changing within 0.549
seconds but did not reach a stable pair until 18.407 seconds. No stale prior
frame settled, but the replacement restore's stable pair was not the baseline.
Thus settlement proves presentation and short-term byte stability, not the
requested rendered pose; see the live report for every per-mutation timing and
trace.

The route reserve must be strictly greater than
`capture.deadlineMs + route.glideDurationMs + 95,813 ms`. That floor admits the
BEGIN marker, pre-mutation safety and continuity probes, glide, locomotion
bridge transaction, nonce cleanup, two bounded fresh-HMD acquisitions, settled
capture, post-mutation safety and continuity probes, boundary-log closure, and
immutable action publication. The restoration
reserve must be strictly greater than
`capture.deadlineMs + route.glideDurationMs + 95,665 ms`; it admits bounded
entry validation, pre/post continuity and capability checks, the zero-offset
bridge transaction, nonce cleanup, settled capture, target shutdown, two
process-proof windows, an optional prior relaunch window, final safety, and
immutable action publication.
Prepare likewise keeps its final `5,000 ms` plus a handoff guard exclusively
for immutable action publication. A completed prepare record whose hard-link
commit misses the post-link fence cannot be reported as prepared: cleanup is
recorded in a distinct, fenced compensation record, and lease release occurs
only after that second publication returns successfully.
Each stage receives a nested subdeadline that preserves the later proof
windows; a slow early stage therefore fails before consuming time reserved for
mandatory downstream evidence. The component allowances are orchestration
policy, not SDK or renderer timing guarantees. These restoration and
publication fences are part of the post-live fake-gated hardening described
above, not behavior rerun on the emulator.

The numbered files under `action-records/` are the semantic action authority;
`actions.jsonl` is a derived, repairable view. Every fenced action checks time
immediately before its hard-link commit and again immediately after. A
post-link deadline or clock failure cannot undo the already committed record:
the returned step/restore result is demoted, reports a structured
`publicationIncidents` entry, and keeps restoration reachable without writing
a conflicting action payload. Completed actions deliberately defer action-
directory fsync, owned staging removal, and derived-view materialization; they
return `actionAuditMaintenance.status: "repair_pending"`. Every later
state-bound call validates the immutable chain before any effect. Filesystem-
only maintenance runs when a later action is published or during a no-device
terminal-restore replay/adjudication; it is not guaranteed to finish before
every later device effect. This is process-lifetime
recovery, not a crash-durability claim: a process crash between hard-link
creation and directory fsync can leave publication durability unknown, and an
incident learned only by the post-link clock sample is not itself persisted
until a later action records the prior audit.

Cleanup remains best-effort when a fixed restoration stage has already missed
its deadline. The receipt keeps that budget failure, while bounded
`cleanupOnly` transport calls still attempt to stop the owned app and converge
safety. Their timeout applies per subprocess rather than as one aggregate
stage wall-time cap, so recovery latency can exceed the nominal stage reserve;
that path cannot report a completed restore. A first restore that can no longer
admit the complete restoration floor receives a fresh bounded recovery
deadline, just like later stopped retries, and the selected deadline source is
recorded in its action receipt.

Prepare also requires a clean Full safety snapshot, including
`sys.guardian.vst.status`, VST state, stage style, safeguard enable/center, and
virtual-content state. It retains bracketed preparation/waypoint boundary
logcat and runs a fresh-launch dialog/runtime-health monitor for at least 60
seconds. Continuity remains bound to the exact boot, APK, PID/start time, and
allowed foreground component throughout the route.

## Drift and movement boundaries

The CP2 experiment used `0.02 m` as the HMD translation-drift threshold.
"Head at origin" in that experiment means `x=0,z=0` at the tracking origin;
the provider reported the stationary eye-height coordinate `y=1.65 m`. The
translation receipt measures baseline-to-pre, baseline-to-post, and pre-to-post
Euclidean distance and reports the translation pass only when the selected
threshold is met. All CP2 measurements were `0 m`. This experiment threshold
is not a general SDK guarantee and is not a claim that the wearer walked.

Each accepted HMD pose must come from a newer provider-listener callback: its
sequence, guest observation time, and guest read time must all advance
strictly. The guest-domain read-minus-observation age may not exceed the CP2
experiment threshold of 250 ms. Both clocks and the computed age are retained
in the drift receipt. The host clock is never compared with the guest clock,
and 250 ms is not an SDK freshness guarantee.

Quaternion drift is recorded with `2 * acos(abs(normalized_dot))`. CP1 defines
no quaternion threshold or quaternion pass gate; do not invent one from the
recorded angle. The route sends in-app root movement only and has no physical-
walk/HMD input.

## Stage and compatibility boundaries

This route accepts only the receipt-bound Full-stage shape (`stageStyle: "3"`,
`rootContainer: "stage"`). An ineligible receipt/AppSpec returns
`capability_unavailable` before live work. After launch, a read-only `commands`
preflight discovers independent locomotion capability revision 1; a legacy
bridge returns `capability_unavailable` before any root mutation, and cleanup
stops the launched target. Scene-snapshot revision 41 and navigation-guide
revision 1 are unchanged.

Mixed and Progressive wiring remains byte-identical to the pre-feature base.
Only eligible Full wiring gets `AgentSpatialViewHost -> AgentWorldRoot`, the
locomotion producer, and the HMD provider/listener. The fixed host is the sole
entity attached directly to `SpatialViewContent`; generated app content is
beneath the movable root, while platform Guardian/Home content is outside that
app-owned hierarchy.

HMD provider/listener ownership follows the host lifecycle deliberately:
`ON_PAUSE`/`ON_STOP` invalidate retained samples, remove the listener, and stop
the provider; `ON_START`/`ON_RESUME` reacquire them. The observer is removed
before composition disposal. Partial cleanup ownership is retained so a later
resume or pause can retry it; composition disposal attempts every retained
owned cleanup and reports any failure instead of claiming successful teardown.

## Restoration and prior foreground

`priorForeground` is explicitly one of `none`, `receipt_bound`, or
`non_receipt_bound`. A receipt-bound incumbent is deliberately not relaunched
after route takeover. A fully prepared route retains a separately validated,
exact clean PID-absence receipt for each prepare clearance. Its restoration
receipt records `relaunchDisposition: "withheld_receipt_bound"` and
`receiptFreshness: "known_stale"` for a stopped receipt-bound incumbent;
`not_evaluated_cp1` applies when no prior process was touched. If prepare fails,
the action audit can instead record `unknown_after_stop_attempt` when a stop was
attempted or command-completed but exact PID absence was not proved. Withholding
still applies in that state: a command-completed force-stop alone never turns
an immutable receipt into proven-stale evidence. A declared non-receipt-bound
prior must belong to a different package than the run-owned target; that prior
may receive one bounded relaunch only after target shutdown is proven, with
its disposition recorded separately and rechecked by final
process/activity evidence.

A command-completed stop receipt is not itself shutdown proof. Shutdown
authority requires both a valid stop receipt completed inside its fixed
subdeadline and a subsequent exact target process/activity absence probe; an
absence snapshot cannot supersede a missing, failed, or late stop barrier.
Restore retains that probe before stopped-process nonce cleanup or prior
relaunch, then retains a second probe after a non-receipt prior relaunch. If a
relaunch transport/receipt fails but the authoritative probe proves the
requested prior activity, restoration can still converge with
`state_proven_after_attempt_error`; the attempted command outcome remains in
the action record. If the pre-relaunch probe already shows the exact prior
component resumed, no launch is repeated and the receipt uses
`state_proven_without_attempt`. Target presence or a missing required prior
activity remains an unresolved cleanup failure. A clean, empty `pidof` exit 1
can prove absence; exit 1 with transport stderr cannot.

Restore is convergent and re-entrant. A failed attempt retains every proven
zero-offset frame, target stop, and nonce cleanup, then a later exact reviewed
request retries only unresolved work under a fresh bounded recovery deadline.
A stopped retry cannot relabel a moved review frame as zero without a bound
zero-offset recovery capture.
A proven emergency stop is a valid cleanup-only restore precondition. Once a
restore completes, an identical replay performs no device probe or effect: it
revalidates the retained receipt, AppSpec, review images, and authoritative
action chain; repairs pending filesystem-only audit maintenance; and returns
the completed receipt with the current audit-maintenance state. Artifact damage
is rejected rather than hidden behind the cached completion.

A command-completed emergency stop does not itself prove that the process or a
guest nonce writer is absent. Restore requires a valid in-deadline stop barrier
and then retains exact target absence before stopped-process nonce cleanup. If
a nonzero mutation may have applied
but no bound zero-offset recovery can be captured after the target is gone,
the terminal result is `restore_failed` with
`restorationDisposition: "safe_release_without_zero_proof"`, never
`zero_proven`. That terminal can release the serial only after exact target and
prior-process disposition, nonce cleanup, Guardian/VST/debug and safeguard-
center safety, and a fenced immutable action publication all succeed. It keeps
the structural failure and review frame, is not adjudication-eligible, and is
idempotently replayable without device work. Any missing proof or audit fence
keeps the serial quarantined for a re-entrant restore retry. This emergency
path is post-live fake-gated hardening and was not rerun on the emulator.

## Source anchors

The source authority is `src/worldlocomotion.ts`: see
`inAppLocomotionInputSchema`, `createInAppLocomotionOrchestrator`,
`hmdPoseFrom`, `driftReceipt`, `checkedFinalProcessProof`, and
`registerInAppLocomotionTools`. Generated guest contracts live in
`src/agentbridge.ts` and the Full-stage lowering in `src/assemble.ts`.
