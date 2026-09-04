# Calibrated scene-target navigation

`navigate_to_scene_target` is a full-surface-only, bounded controller for finding, centering, and
optionally approaching one semantic scene target with the emulator free camera. It uses a
file-acknowledged magenta/cyan `nested-corners-v1` guide, fresh scene geometry, and
`capture_settled` after every guide transition and camera action.

This is not headset locomotion, room-scale navigation, or proof that the camera arrived at a
physical pose. Every result and calibration receipt has `evidenceCeiling: "structural"`. Open the
returned frames before making any statement about their pixels.

## Before calling it

- Register the server with `PICO_MCP_SURFACE=full`; the Doors surface deliberately omits this tool.
- Use the exact online serial and the exact package/build receipt for the foreground debug app.
- The generated app must support navigation-guide bridge revision 1. The Swan mission-table debug
  profile is the first concrete producer.
- Use a new absolute `outDir` outside the repository for every call. The tool creates that exact
  directory and refuses an existing or repository-contained session root.
- A successful `calibrate` call is required before `navigate` can request a forward `w` hold.
  Calibration and navigation must use the same live context described below.

## Exact input schema

Both actions require every field below except `sceneReadiness`, whose bounded defaults are shown in
the table. The schema supplies no motion-policy defaults.

| Field | Exact contract |
| --- | --- |
| `action` | `"calibrate"` or `"navigate"` |
| `serial` | Non-empty exact adb serial |
| `scenario.packageName` | Non-empty package name |
| `scenario.expectedBuildReceiptId` | 64 lowercase hexadecimal characters |
| `scenario.expectedStageStyle` | `"Mixed"` or `"Full"` |
| `scenario.expectedRootContainer` | Exactly `"stage"` |
| `scenario.sceneDriftPolicy.count` | `"strict"` or `"advisory"` |
| `scenario.sceneDriftPolicy.maxTransformDeltaM` | Finite, nonnegative metres |
| `scenario.sceneDriftPolicy.maxTransformDeltaDeg` | Finite, nonnegative degrees |
| `scenario.sceneDriftPolicy.maxExtentDeltaM` | Finite, nonnegative metres |
| `scenario.sceneDriftPolicy.topology` | `"strict"` or `"advisory"` |
| `target.label` | Non-empty semantic label, for example `"TABLE"` |
| `target.selector.kind` | Exactly `"largest_horizontal"` |
| `target.selector.minUpDot` | Finite value from -1 through 1 |
| `target.selector.ambiguity.metric` | Exactly `"area_ratio"` |
| `target.selector.ambiguity.minSeparation` | Finite value from 0 through 1 |
| `objective` | Exactly `"inspect"` |
| `fiducial.colors` | Exactly `[[255,0,255],[0,255,255]]` |
| `fiducial.pattern` | Exactly `"nested-corners-v1"` |
| `fiducial.requireGuideOffOnDelta` | Exactly `true` |
| `centerBandPx.x`, `centerBandPx.y` | Finite, nonnegative pixel tolerances |
| `targetAreaFraction.min`, `.max` | Each greater than 0 and at most 1; `min <= max` |
| `sceneReadiness.maxRetries` | Integer from 0 through 120; defaults to 15 |
| `sceneReadiness.pollMs` | Integer from 10 through 60000 milliseconds; defaults to 1000 |
| `motionPolicy.maxDragPxPerAction` | Positive integer |
| `motionPolicy.maxCumulativeDragPx` | Positive integer |
| `motionPolicy.maxHoldMsPerAction` | Positive integer milliseconds |
| `motionPolicy.maxCumulativeHoldMs` | Positive integer milliseconds |
| `motionPolicy.maxActions` | Positive integer, at most 256 |
| `motionPolicy.maxDurationSec` | Positive integer seconds, at most 7200 |
| `outDir` | New absolute external session-directory path |

The `expectedBuildReceiptId` below is a valid-shape placeholder only. Replace all 64 zeroes with
the exact debug build receipt before calling the tool.

`sceneReadiness` configures the one bounded `query_scene_anchors` operation used for each fresh
scene read; navigation does not add an outer retry loop. The consecutive-read requirement remains
code-owned at two. `maxRetries` counts waits after the initial read. The 15-by-1000 ms default
matches the established scene-query contract and leaves measured headroom over the cold-boot scene
that became ready at retry 7. Exhaustion stops before qemu binding, guide work, capture, or input as
`scene_not_ready`; it is not reported as a backend capability failure.

## Re-runnable calibration call

This example gives calibration enough action and duration budget for the current conservative live
route reserves. It is a bound, not a prediction that the run will take 5000 seconds.

```json
{
  "action": "calibrate",
  "serial": "emulator-5554",
  "scenario": {
    "packageName": "com.fleet.swanmissiontable",
    "expectedBuildReceiptId": "0000000000000000000000000000000000000000000000000000000000000000",
    "expectedStageStyle": "Mixed",
    "expectedRootContainer": "stage",
    "sceneDriftPolicy": {
      "count": "advisory",
      "maxTransformDeltaM": 0.01,
      "maxTransformDeltaDeg": 1,
      "maxExtentDeltaM": 0.01,
      "topology": "strict"
    }
  },
  "target": {
    "label": "TABLE",
    "selector": {
      "kind": "largest_horizontal",
      "minUpDot": 0.85,
      "ambiguity": { "metric": "area_ratio", "minSeparation": 0.15 }
    }
  },
  "objective": "inspect",
  "fiducial": {
    "colors": [[255, 0, 255], [0, 255, 255]],
    "pattern": "nested-corners-v1",
    "requireGuideOffOnDelta": true
  },
  "centerBandPx": { "x": 90, "y": 70 },
  "targetAreaFraction": { "min": 0.08, "max": 0.25 },
  "sceneReadiness": { "maxRetries": 15, "pollMs": 1000 },
  "motionPolicy": {
    "maxDragPxPerAction": 120,
    "maxCumulativeDragPx": 1440,
    "maxHoldMsPerAction": 250,
    "maxCumulativeHoldMs": 3000,
    "maxActions": 32,
    "maxDurationSec": 5000
  },
  "outDir": "/private/tmp/pico-navigation/livingroom-calibration-UNIQUE"
}
```

The code-owned version-2 profile has a fixed, re-runnable schedule:

- Four yaw trials at signed drag magnitudes `[40,-40,80,-80]`, each immediately followed by its
  exact inverse drag.
- Four pitch trials at signed drag magnitudes `[40,-40,80,-80]`, each immediately followed by its
  exact inverse drag.
- Four forward trials at `[50,100,150,200]` ms of `w`, each immediately followed by the same-duration
  `s` restore.

That is 12 outbound trials and 12 restores: 24 camera actions and 24 separately settled waypoints.
Admission reserves one additional possible acquisition action, so `maxActions: 24` is insufficient
even before the duration calculation. `maxDurationSec: 180` is also insufficient for the current
guide transactions, settled captures, continuity probes, per-action route reserves, inverse
recovery, and final cleanup. Either shortage returns `stopReason: "budget_exhausted"` with
`refusalReason: "insufficient_budget"` after read-only scene/window binding but before session
creation, guide mutation, capture, or camera input.

Every applied outbound action is restored even if its post-action settlement fails. A failed or
unsettled restore prevents publication.

## Navigation call

Use the same scenario, target, fiducial, and live context as the accepted calibration. This example
admits a bounded acquire/center/approach loop while remaining below the schema maxima.

```json
{
  "action": "navigate",
  "serial": "emulator-5554",
  "scenario": {
    "packageName": "com.fleet.swanmissiontable",
    "expectedBuildReceiptId": "0000000000000000000000000000000000000000000000000000000000000000",
    "expectedStageStyle": "Mixed",
    "expectedRootContainer": "stage",
    "sceneDriftPolicy": {
      "count": "advisory",
      "maxTransformDeltaM": 0.01,
      "maxTransformDeltaDeg": 1,
      "maxExtentDeltaM": 0.01,
      "topology": "strict"
    }
  },
  "target": {
    "label": "TABLE",
    "selector": {
      "kind": "largest_horizontal",
      "minUpDot": 0.85,
      "ambiguity": { "metric": "area_ratio", "minSeparation": 0.15 }
    }
  },
  "objective": "inspect",
  "fiducial": {
    "colors": [[255, 0, 255], [0, 255, 255]],
    "pattern": "nested-corners-v1",
    "requireGuideOffOnDelta": true
  },
  "centerBandPx": { "x": 90, "y": 70 },
  "targetAreaFraction": { "min": 0.08, "max": 0.25 },
  "sceneReadiness": { "maxRetries": 15, "pollMs": 1000 },
  "motionPolicy": {
    "maxDragPxPerAction": 120,
    "maxCumulativeDragPx": 1440,
    "maxHoldMsPerAction": 250,
    "maxCumulativeHoldMs": 3000,
    "maxActions": 32,
    "maxDurationSec": 5000
  },
  "outDir": "/private/tmp/pico-navigation/livingroom-navigate-UNIQUE"
}
```

There is no hidden `24 actions / 180 seconds` default. A 180-second navigation request cannot
admit the initial guide-off/SHOW/guide-on work, one conservative settled route waypoint, and final
cleanup, so it refuses before any mutation. A larger admitted budget still remains a ceiling: the
controller stops rather than exceeding action, drag, hold, or duration limits.

The controller first acquires both guide colors, centers the nested guide, and only then considers
approach. Detector receipts remain raw, frame-relative observations: their `error` is measured from
the frame center. The controller does not use that field as its fixed point. For every guide-position
decision in acquire, center, and approach, including band acceptance, overshoot history, and
calibrated drag, it recomputes error as `guide.center - (cx, cy)`, where `(cx, cy)` is the principal
point from the fresh camera proof bound into this exact receipt identity. It never substitutes the
frame dimensions for that principal point.

Centering converts that principal-point angular error through the accepted yaw/pitch fits and clamps
the result to the supplied drag limits. Approach derives a desired displacement from the
viewer-facing guide projection, converts it through the accepted forward fit, and admits a bounded
`w` hold only after re-reading and revalidating the receipt. Growing guide area and decreasing
projected depth must follow an acknowledged `w` action before `free_camera_approached` can be
reported. Guide loss, two shrinking observations, projection divergence, scene drift, or exhaustion
stops the loop.

## Calibration identity, receipt, and replay

The calibration context key is the SHA-256 of these canonical fields, with no path or timestamp in
the identity:

- exact serial;
- guest fingerprint and model;
- boot ID;
- qemu PID and window ID, x, y, width, height, and scale;
- capture width and height;
- SHA-256 of the fresh camera-calibration proof bytes;
- bridge revision;
- guide pattern, projection model, both colors, authored width, and authored height.

The authored guide is revision 1, `viewer-facing-planar-v1`, magenta/cyan, 0.74 m by 0.44 m. Any
identity change selects a different context key or invalidates replay. Re-run calibration after a
guest/boot change, qemu restart or window move/resize/scale change, capture-size change, camera
calibration change, bridge revision change, or guide-model/pattern/color/dimension change.

An accepted result contains:

- `calibration.record.yaw`, `.pitch`, and `.forward`, each with literal `samples` and a through-origin
  `fit` containing `slope`, `sampleCount`, signed `residuals`, `rmse`, `maxAbsResidual`, and
  `rSquared`;
- `calibration.quality.status`, `reasons`, and per-axis quality;
- `calibration.projectionQuality.status`, `reasons`, and samples containing `depthM`,
  `widthDepthM`, `heightDepthM`, `depthRelativeError`, `aspectRelativeError`, and `clipped`;
- `calibration.restoreClosure.yaw`, `.pitch`, and `.forward` with four paired residuals each;
- `calibration.finalClosure.{yawDeg,pitchDeg,depthM}`;
- the exact code-owned profile, guide delta hashes, and camera-calibration proof;
- `receiptRef.{path,sha256,bytes}` and `registry.{path,contextKey}` after publication.

The calibration profile and calibration record are both version 2. Its dimensionless quality gates
require four samples per axis, normalized RMSE at most 20%, maximum absolute normalized residual at
most 25%, and R-squared at least 0.95. Each fit residual is normalized by the absolute response
predicted for that trial, `abs(fitted slope * trial input)`, before RMSE and maximum residual are
evaluated. Angular slope magnitude must be at least 0.01 degrees per pixel; forward slope must be at
least 0.0005 metres per millisecond. Every projection depth/aspect relative error must be at most
12% and the guide may not be clipped.

Restore closure is dimensionless too. Each paired restore residual may be at most 25% of that
trial's absolute fitted response. Final yaw, pitch, or depth residual may be at most 12.5% of the
smallest absolute fitted response for that axis's calibration trials. The 20%, 25%, 25%, and 12.5%
values are initial empirical thresholds recorded in the version-2 profile, not principled physical
constants. Receipt publication and replay use the same fit, projection, and closure computations and
gates.

Only an accepted run writes the immutable external
`navigation-calibration-<contextKey>.json` receipt and then atomically publishes its exact-context
registry envelope under `~/.pico-mcp/navigation-calibrations/v1/<contextKey>.json`. Replay requires
the envelope's exact keys, an absolute regular non-symlink receipt, unchanged byte count and
SHA-256, canonical context/record equality, the exact current profile, recomputed fits, accepted
projection/closure evidence, and the camera-proof SHA. The receipt is read once when navigation
loads it and again immediately before every forward hold. A version-1 profile or record fails closed
on replay as `quality_rejected`, with
`calibrationReasonCode: "calibration_policy_version_mismatch"` and matching diagnostic detail; it is
never silently interpreted as version 2.

Missing context records produce `calibrationStatus: "missing"`; unreadable, malformed, orphaned,
or changed receipt bindings produce `"stale"`; weakened profiles, poor fits, projection failures,
or closure failures produce `"quality_rejected"`. None permits a `w` action. Re-run `calibrate`
with a new external `outDir`; never edit a receipt or registry record to make it pass.

## Ordering, cleanup, and fail-closed results

The normal order is:

1. Query fresh scene anchors, verify geometry bytes, select an unambiguous largest horizontal
   target, and bind the exact application/qemu window.
2. Admit the whole-action budget and reserve the external session. Before SHOW or any camera input,
   request an idempotent HIDE and require an acknowledgement with exact hidden cleanup proof. This
   is the navigation-guide capability preflight: a legacy bridge fails cleanly with
   `guide_not_acquired` instead of entering the motion loop.
3. Capture a settled guide-off frame and prove both colors absent, then SHOW through the
   file-acknowledged bridge and capture a settled guide-on frame. If both colors are immediately
   detected, that frame must differ byte-for-byte from guide-off. If the guide remains absent and
   the bytes are identical, the controller may enter its bounded acquisition series; after
   acquisition, a repeated same-view HIDE/off/SHOW/on sequence must prove both colors and an off/on
   byte delta. The distinct, identity-valid guide-on rebaseline capture may reuse the last
   acquisition waypoint SHA; only post-action waypoints require a fresh SHA. Each guide request
   allows 30 polls at 100 ms and requires two stable reads;
   the current acknowledgement budget floor is therefore 30-by-100 ms rather than three polls.
   Each `run-as` acknowledgement read is itself capped at 1 second; broadcasts and cleanup commands
   are capped at 10 seconds. The code reserves 55 seconds for HIDE and 120 seconds for SHOW,
   conservatively covering a failed SHOW, its one compensating HIDE, both sets of bounded reads and
   cleanup, and the final late-ack sweep.
4. Execute every acquire, center, calibration, restore, or approach action through the shared route;
   every action must have an applied acknowledgement and its own settled capture.
5. Capture a fresh final diagnostic while the guide is visible, acknowledge HIDE, then capture a
   settled final-clean frame with no intervening backend action.
6. Set `sameViewEvidence: "no_backend_action_requested"` only when the hide proof, diagnostic, and
   clean capture all satisfy that order. Calibration publication occurs after cleanup.

Cleanup is attempted whenever SHOW may have applied, including stopped and error paths. Cleanup
failure is reported rather than hidden. `executionStatus` is `completed`, `stopped`, or `error`;
`stopReason` is one of `objective_satisfied`, `ambiguous_target`, `label_absent`,
`guide_not_acquired`, `unsettled`, `scene_drift`, `scene_not_ready`, `budget_exhausted`,
`ambiguous_host_window`, `unsupported_backend`, `input_failed`, `binding_failed`, or
`cleanup_failed`. `refusalReason` is
`insufficient_budget`, `missing`, `stale`, `quality_rejected`, `projection_divergence`, or null.

`achievedClaims` are independent `target_visible`, `target_centered`, and
`free_camera_approached` facts. A later stop does not erase an earlier bounded observation, and no
field means arrived, walked, headset pose, or physical-device navigation.

## LOOK obligations

Every capture receipt has structural provenance and requires a LOOK. Open every returned
guide-off, guide-on, acquisition/waypoint, final-diagnostic, and final-clean frame that you rely on.
In particular:

- judge the final available guide-visible diagnostic before claiming target visibility or
  centering;
- confirm the guide is absent in the final-clean frame;
- retain ordered paths and SHA-256 values with the action receipt;
- use a separate exact-frame verification record only after the frame was actually looked at.

The navigation tool itself never upgrades emulator pixels beyond its structural evidence ceiling.
