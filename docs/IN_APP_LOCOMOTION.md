# Receipt-bound in-app locomotion (CP1)

`run_in_app_locomotion_route` is a full-surface-only, receipt-bound route
orchestrator for a PICO Spatial Full stage. Its contract is deliberately
staged: `prepare` → reviewed `step` calls → `restore` → `adjudicate`. It binds
the exact native run receipt, APK hash, serial, runtime context, safety state,
and external artifact root before it accepts a route.

This page documents the CP1 contract. CP2 has not run, and there is no
productized live proof for this route. The historical [L0 spike](evidence/locomotion-spike-2026-09-02/L0.md)
is an experiment record, not current product verification.

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

Mechanism selection remains pending CP2. Compare `direct` and `replacement` on
the same emulator boot, and select a primary mechanism only when
semantic-settled rendered frames prove it. Keep the other as a documented
fallback only if its own rendered frames independently prove it; otherwise
mark it `UNVERIFIED`.

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
renderer-delay guarantee.

Prepare also requires a clean Full safety snapshot, including
`sys.guardian.vst.status`, VST state, stage style, safeguard enable/center, and
virtual-content state. It retains bracketed preparation/waypoint boundary
logcat and runs a fresh-launch dialog/runtime-health monitor for at least 60
seconds. Continuity remains bound to the exact boot, APK, PID/start time, and
allowed foreground component throughout the route.

## Drift and movement boundaries

The pending CP2 experiment uses `0.02 m` as the HMD translation-drift
threshold. The
translation receipt measures baseline-to-pre, baseline-to-post, and pre-to-post
Euclidean distance and reports the translation pass only when the selected
threshold is met. This threshold is not a claim that the wearer walked or that
locomotion is product-ready.

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
after route takeover. The restoration receipt records
`relaunchDisposition: "withheld_receipt_bound"` and CP1 freshness
`known_stale` (or `not_evaluated_cp1` before the route has stopped). This
receipt-bound withholding prevents a stale prior receipt from being presented
as a restored proof. A declared non-receipt-bound prior may receive one bounded
relaunch only after target shutdown is proven, with its disposition recorded
separately and rechecked by final process/activity evidence.

A command-completed stop receipt is not itself shutdown proof. Restore retains
an exact target process/activity probe before stopped-process nonce cleanup or
prior relaunch, then retains a second probe after a non-receipt prior relaunch.
If a stop or relaunch transport/receipt fails but the authoritative probe proves
the requested final state, restoration can still converge; a relaunch in that
case is reported as `state_proven_after_attempt_error`, and the attempted
command outcome remains in the action record. If the pre-relaunch probe already
shows the exact prior component resumed, no launch is repeated and the receipt
uses `state_proven_without_attempt`. Target presence or a missing required prior
activity remains an unresolved cleanup failure. A clean, empty `pidof` exit 1
can prove absence; exit 1 with transport stderr cannot.

Restore is convergent and re-entrant. A failed attempt retains every proven
zero-offset frame, target stop, and nonce cleanup, then a later exact reviewed
request retries only unresolved work under a fresh bounded recovery deadline.
A stopped retry cannot relabel a moved review frame as zero without a bound
zero-offset recovery capture.
A proven emergency stop is a valid cleanup-only restore precondition. Once a
restore completes, an identical replay returns the immutable receipt without
repeating effects.

## Source anchors

The source authority is `src/worldlocomotion.ts`: see
`inAppLocomotionInputSchema`, `createInAppLocomotionOrchestrator`,
`hmdPoseFrom`, `driftReceipt`, `checkedFinalProcessProof`, and
`registerInAppLocomotionTools`. Generated guest contracts live in
`src/agentbridge.ts` and the Full-stage lowering in `src/assemble.ts`.
