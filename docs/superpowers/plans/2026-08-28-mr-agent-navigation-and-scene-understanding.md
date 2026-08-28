# MR Agent Navigation and Scene Understanding Plan

> **DESIGN ONLY:** Do not execute this plan in this wave. A later, separately authorized
> implementation wave may change source, drive an emulator, build apps, or touch hardware. This
> document is the only tracked output of the present read-only recon.

**Product goal:** “Optimize, enhance, and evolve the way agents can drive around inside the
emulator itself and visually confirm and drive themselves from an MR perspective on where things
fit, and identify objects from a scene understanding perspective,” as a step toward live PICO
hardware testing and a store-launch application.

**Primary lane:** Mixed stage / MR. Full Space remains a first-class explicit lane. The current
AppSpec defaults to stage style `1` (Mixed) and exposes style `3` (Full) as an explicit option
(`src/appspec.ts:49-58`); the existing design also describes Mixed as room-seated content and Full
as app-owned enclosure (`DESIGN.md:99-117`).

**Goal of the first buildable increment:** Let an agent ask for a semantic target such as TABLE,
visually acquire an app-rendered guide for one runtime-matched TABLE anchor, move the emulator free
camera in bounded relative steps until the guide is centered and inspectable, and return a settled
capture trace. “Walk to the table” must initially mean **free-camera visual approach**, not physical
locomotion or arrival at an absolute pose.

**Architecture:** Add one observation substrate shared by three consumers: navigation, semantic
relation assertions, and regression scenarios. The substrate binds (1) a runtime semantic-anchor
snapshot, (2) settled rendered captures, (3) every relative input action, and (4) immutable hashes
into one trace. Emulator motion remains a replaceable backend. On hardware the backend does not
move the camera: the user's head supplies the viewpoint, while adb capture, app scene queries, the
automated eye, and the ledger remain candidate shared primitives subject to the hardware
prerequisites below.

**Authorized output boundary:** This design wave may add only this document. It must not change
source, tests, manifests, packages, evidence ledgers, snapshots, the emulator, or a device.

**Proposal boundary:** Except for the cited current-state inventory in Section 2, every acceptance
term, interface, backend, tool schema, controller, relation predicate, roadmap outcome, test, and
rollout rule in Sections 1 and 3–14 is a **PROPOSED FUTURE CONTRACT**, not an existing capability.

## 1. Acceptance language and non-goals

The system must report the strongest statement its observations support:

- `target_visible`: the requested guide was detected in a returned frame.
- `target_centered`: the guide remained within a declared image-space band after a settled input
  action.
- `free_camera_approached`: the guide's image-space size entered a declared band without violating
  the vertical guard.
- `relation_geometry_pass`: an app-reported subject bound satisfied a declared predicate against a
  runtime-matched semantic mesh in one coordinate frame.
- `relation_witnessed`: someone LOOKed at the exact clean and diagnostic captures and described the
  visible pixels; the linked SDK-label/geometry predicate remains a separate structural claim.

The first implementation must not say `arrived`, `at_pose`, `walked`, `collision_free`,
`world_localized`, or `device_navigated`. The repository exposes relative free-camera controls and
explicitly reports that direct head-pose input does not move the rendered view
(`src/cameradrive.ts:15-25`; `src/grpc.ts:235-265,279-296`).

This plan does not design production gameplay locomotion, modify an application's release UI,
infer real-world object identity from pixels alone, or automate a user's head. It designs a debug
and verification plane that store-scale applications can opt into in non-release builds.

## 2. Repository- and evidence-derived inventory

### 2.1 Capture and free-camera motion that exist now

| Surface | What is grounded | Current boundary |
| --- | --- | --- |
| `capture_frame` | Takes `serial`, `outPath`, and `maxDim`; saves a full-resolution adb `exec-out screencap -p`, attempts to return a downscaled image, falls back to the full-resolution bytes if that conversion fails, and identifies the result as the forward HMD view (`src/capture.ts:34-68`). | Capture only; it does not choose a viewpoint. |
| `capture_canonical` | Optionally sends RECENTER, waits a fixed delay, captures, hashes, measures, and compares `expectSha`; it reports the rendered effect of RECENTER as unverified (`src/eye.ts:305-345`). | Fixed-delay capture, not inertia-aware settling and not absolute-pose establishment. |
| `emulator_look` | Finds the qemu host window, posts a macOS CoreGraphics right drag, waits 800 ms, then captures (`src/emulatorlook.ts:29-65,69-105`). | macOS + Accessibility; one fixed wait, no two-frame settle test. |
| `capture_orbit` | Applies ordered WASD/QE holds over gRPC and right drags over CoreGraphics, then captures after settling (`src/cameradrive.ts:97-123,135-172`). | Relative commands only; rotation is macOS-only. |
| `capture_multiview` | Produces front, high, left-oblique, and right-oblique frames, attempts inverse moves, and byte-compares the restored frame with the starting frame (`src/cameradrive.ts:176-264`). | It reports when the round trip does not close; it does not recover an absolute pose. |

Translation uses `EmulatorController.sendKey` keydown, hold, and keyup; WASD/QE motion is relative to
the current facing and carries a smoothing/inertia tail (`src/cameradrive.ts:15-25,54-83`). Rotation
uses a right-button host drag because the measured gRPC `sendMouse` and XR head events do not rotate
or move the rendered view (`src/cameradrive.ts:20-25`; `src/grpc.ts:279-296`). The settle primitive
takes up to 12 adb captures 700 ms apart and returns success only after two consecutive byte-equal
frames; on exhaustion it returns the last frame with `settled:false` (`src/cameradrive.ts:36-52`).

The source says movement is relative to “current facing” (`src/cameradrive.ts:15-19,97-104`). The
mission's stronger constraint—that forward motion follows the full view direction including
pitch—is treated as a standing design input. Its exact pitch/translation decomposition is
**UNVERIFIED** in tracked source, so the proposed controller refuses approach steps while the target
is outside a narrow vertical image band.

There is a serial-routing defect to close before agent navigation: `keyHold` receives `serial` but
calls `getClient()` without it on both connection attempts (`src/cameradrive.ts:54-73`), while the
gRPC layer can match a discovery endpoint to an adb serial and reject ambiguity
(`src/grpc.ts:57-94`).

All five low-level capture/motion tools are full-surface registrations
(`src/index.ts:215-255,334`). The current Doors `pico_look` accepts no input and explicitly advertises
no pose control (`src/doors.ts:417-425`). A future design should extend that Door compatibly rather
than expose a long low-level move program to the default surface.

### 2.2 The automated eye and evidence ladder

The current eye measures brightness, non-black coverage, dominant colors, and connected components;
its foreground count drops the largest thresholded component as background
(`src/eye.ts:139-189`). A frame above 0.5 non-black coverage is classified as passthrough/MR
(`src/eye.ts:68-75`). In that lane, legacy object count, not-mostly-black, and dominant-color checks
are advisory; only authored color-key evidence can score (`src/eye.ts:212-276`). Color keys are
normalized from authored palettes, neutral keys are rejected by a channel-spread rule, and the
detector returns per-key pixel counts and bounding boxes (`src/eye.ts:97-137`). The MR lane needs at
least two non-neutral authored key entries to auto-score; the current implementation does not
deduplicate equal RGB values stored under different names. Zero detected keys is a hard failure,
and weak or unavailable evidence escalates (`src/eye.ts:254-277`). The proposed guide producer must
require two actually different RGB values.

`visual_judge` snapshots source bytes to a private file, verifies the snapshot hash did not change
during measurement, producer-authors the measured claim, and treats caller prose as unverified
context (`src/eye.ts:379-450`). Only a measured PASS can ask the producer to append `auto_judged`;
FAIL and ESCALATE do not record (`src/eye.ts:421-456`). The ledger rejects image-grounded claims
without a valid frame and attestation, restricts `auto_judged` to its producer, and materializes
accepted bytes into content-addressed storage (`src/ledger.ts:536-558,587-671`).

The effective evidence order used by the hardware protocol is:

```text
structural < auto_judged < vision_verified < device_verified
```

The full repository also has evidence kinds between or beside these four, but these are the four
relevant classes for this design (`src/ledger.ts:35-55`; `docs/DEVICE_VERIFICATION.md:40-47`).
`vision_verified` requires a real image and a sight-specific attestation; `device_verified` adds a
live non-emulator PICO identity probe and a fresh same-serial capture whose bytes exactly equal the
already-looked artifact (`src/ledger.ts:813-877`; `docs/DEVICE_VERIFICATION.md:14-38`).

### 2.3 Scene understanding that exists now

The documented Spatial SDK surface exposes plane center/bounds/orientation plus one semantic label,
and mesh transforms, 3D bounds, vertices, indices, and a semantic list described as per-vertex/region
(`docs/spatial-interaction-api.md:877-928`). Its semantic enum includes FLOOR, WALL, TABLE,
WALL_ART, and other room categories (`docs/spatial-interaction-api.md:983-1012`).

The generated scene helper subscribes before starting mesh tracking, retains ADDED/UPDATED anchors,
removes REMOVED anchors, and also supports one-shot loading (`src/sense.ts:194-227`). Its dump path
polls until either the subscription or one-shot load is non-empty because RUNNING alone was measured
before data readiness (`src/sense.ts:229-246`). The current helper describes semantics as per-face
but collapses the raw list to a distinct anchor-level label set for logging
(`src/sense.ts:247-263`); the API document instead describes a per-vertex/region list
(`docs/spatial-interaction-api.md:917-928`). The exact semantic-element alignment and the rule for
deriving label-specific triangles are **UNVERIFIED**. Anchor-level deduplicated labels are valid
selectors only; triangle-level labeled-region predicates remain blocked until a lossless snapshot
and fixtures prove the raw assignments' alignment to vertices and indices.

`SceneUnderstanding.anchorsLabeled` loads a fresh snapshot and filters anchors whose semantic set
contains the requested label (`src/sense.ts:265-271`). It does not itself perform the readiness
poll, so a host tool must not expose an immediate empty list as a stable “not found” result. Scene
queries also require an open Stage; older “Full Space” wording means an open Stage of any style, not
necessarily stage style 3, and a WindowContainer returns no surfaces (`src/sense.ts:21-27`;
`src/placeonsurface.ts:72-80`).

The source records a measured emulator result of 44 anchors through both subscription and one-shot
paths and explicitly identifies the older zero result as a readiness race (`src/sense.ts:29-45`).
This measured source supersedes the stale “likely empty” emulator caveats and the RUNNING-only
guidance still present in `docs/spatial-interaction-api.md:877-878,904-905,969-970`.

The external Museum sweeps (host-picker spelling: `Mesume`) establish that useful labels exist but
are not stable identities:

- Museum Day measured 49 anchors, including four WALL_ART, one TABLE, and three FLOOR labels
  (`/Users/sushantsrikrish/.pico-mcp/evidence/mesh-sweep/museum-day.txt:3,20-22,36,45-54`).
- Museum Night measured 38 anchors, including two WALL_ART, two TABLE, and one FLOOR label
  (`/Users/sushantsrikrish/.pico-mcp/evidence/mesh-sweep/museum-night.txt:6,17-18,25,28,38,41,45-46`).
- A later Day→Night→Day re-selection produced Day counts of 46 then 48 instead of 49, while
  WALL_ART/TABLE/FLOOR counts also changed; the evidence therefore requires runtime label matching,
  re-querying, and range-tolerant assertions
  (`/Users/sushantsrikrish/pico-worlds-in-a-room/evidence/inventory-comparison-2026-08-10.md:65-80`).
- Later Night runs measured 43 and 44 anchors rather than the 38-anchor baseline, with WALL_ART
  changing from two to three in the cited remeasurement; these are run-scoped observations, not
  durable bounds (`/Users/sushantsrikrish/pico-worlds-in-a-room/evidence/inventory-comparison-2026-08-10.md:23-63`;
  `/Users/sushantsrikrish/pico-worlds-in-a-room/evidence/phase0/PHASE0-FINDINGS.md:29-35`).
- In the cited 2026-08-10 Day/Night session, recurring geometry was more consistent than count or
  index, but even FLOOR alternated between a large slab and a small rug. Whether those geometric
  selector features remain stable across reboots, SDK versions, other environments, or hardware
  rooms is **UNVERIFIED**
  (`/Users/sushantsrikrish/pico-worlds-in-a-room/evidence/inventory-comparison-2026-08-10.md:82-98`).

Existing Phase-0 evidence includes multi-angle LOOKs with diagnostic proxies on TABLE, FLOOR, and
WALL_ART (`/Users/sushantsrikrish/pico-worlds-in-a-room/evidence/phase0/PHASE0-FINDINGS.md:20-39`).
Representative retained frames are:

- `/Users/sushantsrikrish/pico-worlds-in-a-room/evidence/phase0/day-wallband-on-artwall.png`
- `/Users/sushantsrikrish/pico-worlds-in-a-room/evidence/phase0/day-slots-floor-wall-plinth.png`
- `/Users/sushantsrikrish/pico-worlds-in-a-room/evidence/phase0/night-slots-floor-wall-plinth.png`

Those frames prove that a guest-rendered semantic diagnostic can create a lookable witness. They do
not prove the new object-relation predicate, navigation controller, or hardware behavior proposed
here.

All absolute evidence paths in this section are machine-local receipts, not portable repository
links. Their SHA-256 values bind the files inspected in this design wave: Day sweep
`13399dde1d54177752d88ed4757a01e39b523a47e178e0c00d3a2190445911ab`, Night sweep
`d1fe141c75bd20a780a7339600d75320ff284d259984d5d636a184797885170d`, inventory comparison
`be34a9c89676d90ca29646fc9de7466bccd064a82420230a5ca65fe1ca48ebc4`, Phase-0 findings
`eda3b4179948bc7ff4dcf09ab47be04c3419a7d6d1eefae8e0c6d75840b2e177`, and the three listed
images respectively `0e98b1d41bf86215dd61aa7b6a965f46b18cf0f1a36a638ff80216c5dfc6b4fc`,
`541ee13fd2250a12b0afe93985c78ab9be9162f954ca179ce23a7e9d5f9e541b`, and
`952ed844fcac2d262b846cbac3fc49e41b278d88005efb8796c664b57e4cc830`.

### 2.4 Snapshot determinism and gRPC discovery

`snapshot_save` and `snapshot_load` are thin wrappers around adb emulator snapshot commands; neither
waits for post-load readiness or captures a frame (`src/agentloop.ts:53-81`). One completed recapture
wave saved and loaded `sdk-6-showcase-golden-v1`, observed boot completion and a healthy process, and
produced a restored capture byte-identical to the already-looked receipt frame at SHA-256
`2696ba68ece98a22d05a00c69179d984ac7f547354f296fed2dfe5dbb13e4836`
(`/Users/sushantsrikrish/pico-sdk6-validation/evidence/golden-recapture-2026-08-28/run-notes.md:93-103`).
That local-only run-notes receipt has SHA-256
`29073e329b1e5413d66894c3e619d18c1b6f4d46d5bb0d4a925d82d792c4f348`. It is proof for one
app/snapshot/run, not a universal snapshot-determinism guarantee.

The emulator publishes discovery INI files beneath the configured discovery directory; the parser
extracts their entries (`src/toolchain.ts:11-13`; `src/emulator.ts:21-35`). The gRPC client loads the
installed emulator's proto dynamically and can match `port.serial` to an adb serial. When a
discovery entry is present, it uses the advertised port and optional Bearer token; an explicit
serial with no matching record fails closed, while a call with neither an explicit serial nor a
discovery record currently falls back to unauthenticated port 8554 (`src/grpc.ts:14-54,57-94`).
`keyHold` additionally hard-codes 8554 during recovery and omits the serial on both client
selections (`src/cameradrive.ts:54-73`). Phase 1A must remove or explicitly constrain that fallback,
re-read discovery, retain endpoint/discovery identity plus only token presence/fingerprint—not the
token—and test token-present, token-absent, missing-record, and multi-endpoint cases.

### 2.5 The current hardware boundary

The existing CGEvent rotation path finds and drives a macOS qemu window, so it is emulator-host
automation rather than an XR-device primitive (`src/emulatorlook.ts:29-65`; `src/cameradrive.ts:85-94`).
The hardware protocol explicitly classifies emulator lifecycle, snapshots, free-camera, and mapped
controller tools as emulator-only; it identifies adb capture, Agent Bridge scene assertions, the
file-based eye, and ledger reporting as serial-capable or device-independent code paths
(`docs/DEVICE_VERIFICATION.md:143-161`).

The repository has not executed its device protocol on PICO hardware and has no effective
real-hardware `device_verified` row. Its tests establish validation flow, not device identity,
capture timing, adb behavior, or pixels (`docs/DEVICE_VERIFICATION.md:3-12`). A hardware adb
screencap may also be black or change before the ledger's required recapture; both conditions are
explicitly unresolved (`docs/DEVICE_VERIFICATION.md:68-77`).

## 3. Design decisions

### 3.1 Use hybrid visual servoing, not invented localization

Three approaches were considered:

1. **World-space path planning from the semantic mesh.** Rejected for phase 1 because the system has
   target world transforms but no grounded absolute free-camera transform.
2. **Blind relative scripts.** Retained only as a low-level fallback because inertia and drift make a
   fixed action list an observation-poor controller (`src/cameradrive.ts:23-25,251-260`).
3. **Hybrid semantic target + guest guide + visual servo.** Selected. The app renders a unique debug
   guide at the runtime-selected semantic anchor; the host searches for and centers its authored
   color key, moves in short bounded steps, settles, and observes again.

The selected controller never estimates an absolute pose. Its state is an observation history:
anchor snapshot ID, action sequence, capture hashes, guide bounding boxes, target-size trend, settle
results, and remaining budget.

### 3.2 Treat labels as selectors, not identities

Every invocation re-queries the mesh and matches on semantic LABEL. UUID, list index, total count,
and “the third wall” are trace-local diagnostics only. When several anchors share a label, the
caller supplies a geometric selector such as `largest_horizontal`, `nearest_to_subject`,
`closest_to_point`, or a bounded extent/position range. An ordinal is never a durable contract.
Ambiguous top candidates inside a declared margin return `ambiguous`, not an arbitrary winner.

Assertions accept ranges. Examples include `matchingAnchorCount: {min:1,max:4}` and
`overlapRatio: {min:0.70}`. A changed count can be reported as drift without failing a relation that
still has one unambiguous geometric match.

### 3.3 Render fusion evidence in the guest coordinate frame

Phase 2 avoids projecting host-side mesh coordinates with unknown camera extrinsics. An opt-in debug
bridge inside the app renders the chosen anchor band and the subject outline in the same world frame
as the app content. It emits one clean frame and one diagnostic frame without requesting a backend
action between them. Until a pose/tick receipt exists, “same viewpoint” means only “no requested
motion”; actual pose equality and atomic subject/mesh/capture sampling are **UNVERIFIED**, especially
on hardware. Reports expose `sameViewEvidence`, bridge revision IDs, and monotonic timestamps and
ESCALATE when a configured drift bound cannot be established. The diagnostic is evidence of the
predicate inputs; the clean frame is evidence of the user-facing render. Neither substitutes for
the other.

This design requires the app to expose subject world bounds and a debug-only semantic overlay.
That integration, and equality of the subject and scene-understanding coordinate frames across all
stage styles, are **UNVERIFIED** prerequisites.

### 3.4 Keep motion backends explicit

The common observation engine depends on an interface, not on CGEvent:

```ts
interface ObservationBackend {
  identity(): RuntimeIdentity;
  captureSettled(policy: SettlePolicy): Promise<SettledCapture>;
  queryAnchors(query: AnchorQuery): Promise<AnchorSnapshot>;
  applyRelativeAction?(action: RelativeAction): Promise<ActionReceipt>;
  prepareDiagnostic?(request: DiagnosticRequest): Promise<DiagnosticReceipt>;
}
```

- `emulator_macos` (**PROPOSED; blocked on Phase 1A**): serial-qualified adb capture and
  discovery-selected gRPC keys. CGEvent look is permitted only after a verified
  adb-serial-to-qemu-window binding. A single eligible qemu window is sufficient only when exactly
  one online emulator serial and one matching discovery endpoint also exist and both equal the
  request; a headless second emulator otherwise makes the target ambiguous. That correlation is
  **UNVERIFIED**; any unmatched runtime returns `ambiguous_host_window` without dragging. The current
  helpers focus the first qemu process and drag the largest qemu window without a serial association
  (`src/cameradrive.ts:30-33`; `src/emulatorlook.ts:29-49`). The trace records serial, endpoint, host
  process/window identity, online-emulator set, and binding method.
- `emulator_keys_only`: candidate adb capture + discovery-selected gRPC keys, without autonomous
  rotation. Off-macOS focus delivery and rendered translation are **UNVERIFIED** because the measured
  motion requires the emulator window frontmost while the focus helper is a no-op off Darwin
  (`src/cameradrive.ts:15-25,30-33`).
- `pico_device_guided`: adb capture + scene query + user-positioned head; no
  `applyRelativeAction`.

Calling a backend without the requested primitive returns `unsupported_backend`; it never silently
falls back to a different serial, host window, or evidence class.

## 4. Proposed tool surfaces

All contracts in this section are **PROPOSED**, not existing capabilities.

### 4.0 Common contract types and invariants

Every successful primitive returns the binding level it can actually establish:

- `captureRuntimeBinding`: adb serial and live identity, capture source, and monotonic start/end
  timestamps. When motion is used it also includes gRPC discovery file, discovered serial, endpoint,
  token-presence/fingerprint only, online-emulator set, and qemu PID/window ID plus serial-binding
  method.
- `applicationRuntimeBinding`: extends `captureRuntimeBinding` with package/build receipt,
  app-reported stage style (`Mixed` or `Full`), root-container state, bridge schema/revision, and the
  effective scenario/drift policies. Composite navigation, scene, relation, and device-session tools
  require this full binding; `capture_settled` alone does not invent application identity.
- `captureRef`: absolute external path, SHA-256, byte count, dimensions, source serial, capture
  timestamp, and optional run-receipt ID. Room captures never enter the repository.
- `geometryRef`: absolute external path, SHA-256, byte count, schema version, coordinate-frame ID,
  units, handedness, and bridge revision. Room geometry never enters the repository.

JSON examples below abbreviate nested common bindings with `{}` where detail is not germane; an
implementation must return every required common field. Every error after runtime selection also
returns the resolved binding, typed error code/detail, completed action receipts, and last valid
capture reference, if any.

Missing or contradictory required identity is `binding_failed`, not a partial success. An observed
stage style that differs from the requested scenario is `stage_mismatch`. If the app cannot report
stage style/build identity, the tool does not infer them from a brief.

Every composite call includes a `scenario` object with `packageName`, `expectedBuildReceiptId`,
`expectedStageStyle`, `expectedRootContainer:"stage"`, and a complete `sceneDriftPolicy`; output
echoes the effective values. A versioned manifest reference may replace the inline object only when
the returned trace embeds that manifest's path, hash, and parsed values.

Selectors are a discriminated union; every selector includes a dimensioned ambiguity rule:

```json
{
  "selector": {
    "kind": "largest_horizontal",
    "minUpDot": 0.85,
    "ambiguity": {"metric": "area_ratio", "minSeparation": 0.15}
  }
}
```

Other allowed forms are `closest_to_point` with `pointWorldM`, `maxDistanceM`, and
`minSeparationM`; `nearest_to_subject` with `maxDistanceM` and `minSeparationM`; and `extent_range`
with min/max metre bounds plus `minSeparationM`. Outside `assert_scene_relation`,
`nearest_to_subject` also requires a previously acquired `subjectReceiptId`. Inside that tool, the
tool acquires the declared entity's receipt first, injects its real ID into the evaluated selector,
and echoes it; placeholder receipt IDs are invalid. The selected rule and every candidate score are
echoed in output.

Exact hashes are provenance, not a universal stability predicate. Each call separately declares a
drift policy over anchor count, label set, transform metres/degrees, extent metres, and topology.
The tool re-matches geometrically and returns measured deltas. Exceeding any strict bound or losing
the selected target is `scene_drift`; within-bound drift is reported rather than hidden.

### 4.1 Full surface: `capture_settled`

```json
{
  "serial": "emulator-5554",
  "outPath": "/tmp/pico-render/waypoint-03.png",
  "maxDim": 1200,
  "maxTries": 12,
  "intervalMs": 700,
  "comparison": "byte_exact"
}
```

Output:

```json
{
  "status": "settled",
  "serial": "emulator-5554",
  "path": "/tmp/pico-render/waypoint-03.png",
  "sha256": "...",
  "attempts": 4,
  "settlementSatisfied": true,
  "comparison": "byte_exact",
  "stablePair": ["...", "..."],
  "captureRuntimeBinding": {"serial": "emulator-5554", "captureSource": "adb-exec-out-screencap"},
  "evidenceCeiling": "structural",
  "lookRequired": true
}
```

`status` is `settled`, `timeout`, or `capture_failed`. A timeout still returns the last valid frame
and its hash but sets `settlementSatisfied:false` and cannot satisfy a navigation waypoint. LOOKing
at that last frame may support a claim about its pixels, but never a claim that motion settled. This
extracts the existing two-identical-frame discipline from `capture_orbit`
(`src/cameradrive.ts:36-52,149-169`) and applies it consistently after look, move, snapshot restore,
and device-guided capture. Exact equality on a dynamic hardware/MR frame may never occur; the
hardware comparison policy is **UNVERIFIED** and must fail closed until measured.

### 4.2 Full surface: `query_scene_anchors`

```json
{
  "serial": "emulator-5554",
  "scenario": {
    "packageName": "com.example.app",
    "expectedBuildReceiptId": "...",
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
  "labels": ["TABLE", "WALL_ART"],
  "maxRetries": 15,
  "pollMs": 1000,
  "includeGeometry": "lossless_external_artifact",
  "stabilityReads": 2
}
```

Output includes:

```json
{
  "status": "ready",
  "snapshotId": "sha256-of-normalized-runtime-snapshot",
  "applicationRuntimeBinding": {
    "serial": "emulator-5554",
    "packageName": "com.example.app",
    "buildReceiptId": "...",
    "observedStageStyle": "Mixed",
    "rootContainer": "stage",
    "bridgeRevision": 41
  },
  "queriedAtMonotonicNs": "...",
  "trackingState": "RUNNING",
  "retries": 2,
  "totalAnchorCount": 48,
  "matchedAnchorCount": 3,
  "geometryRef": {
    "path": "/external/session/scene-41.json",
    "sha256": "...",
    "schemaVersion": 1,
    "units": "metres",
    "handedness": "sdk-reported",
    "coordinateFrameId": "bridge-world-41"
  },
  "anchors": [
    {
      "traceId": "snapshot-local-id",
      "runtimeUuid": "diagnostic-only",
      "labels": ["WALL_ART"],
      "worldFromAnchor": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      "boundsM": [0.08, 1.14, 6.28],
      "geometrySlice": {"vertexStart": 0, "vertexCount": 128, "indexStart": 0, "indexCount": 378},
      "semanticAssignments": {
        "domain": "unknown",
        "rawCount": 128,
        "alignment": "unverified",
        "relationEligible": false
      }
    }
  ],
  "histogram": {"WALL_ART": 3},
  "drift": {"effectivePolicy": {}, "exactSnapshotChanged": false, "withinPolicy": true, "deltas": []},
  "evidenceCeiling": "structural"
}
```

The host parser must consume a versioned, lossless bridge payload rather than scrape a possibly
truncated per-anchor log line. It first establishes readiness from an **unfiltered** non-empty mesh,
then filters labels. A ready non-empty mesh with zero label matches is `label_absent`; exhausting the
unfiltered readiness budget is `not_ready`; an unopened Stage is `stage_not_open`. Other terminal
statuses are `bridge_unavailable`, `stage_mismatch`, `invalid_payload`, and `binding_failed`.

The lossless geometry artifact contains `worldFromAnchor`, coordinate metadata, raw vertices,
indices, and raw semantic assignments. It normalizes float precision only for the snapshot hash and
reports both exact and policy-bounded drift. Until fixtures validate whether semantic assignments
map to vertices, faces, or regions, `alignment:"unverified"` blocks label-specific triangle
relations and diagnostic bands. Anchor-level labels may still select an anchor. Raw room geometry
is external evidence and must not be written into the repository.

### 4.3 Full surface: `navigate_to_scene_target`

```json
{
  "serial": "emulator-5554",
  "scenario": {
    "packageName": "com.example.app",
    "expectedBuildReceiptId": "...",
    "expectedStageStyle": "Mixed",
    "expectedRootContainer": "stage",
    "sceneDriftPolicy": {"count": "advisory", "maxTransformDeltaM": 0.01, "maxTransformDeltaDeg": 1, "maxExtentDeltaM": 0.01, "topology": "strict"}
  },
  "target": {
    "label": "TABLE",
    "selector": {
      "kind": "largest_horizontal",
      "minUpDot": 0.85,
      "ambiguity": {"metric": "area_ratio", "minSeparation": 0.15}
    }
  },
  "objective": "inspect",
  "fiducial": {
    "colors": [[255, 0, 255], [0, 255, 255]],
    "pattern": "nested-corners-v1",
    "requireGuideOffOnDelta": true
  },
  "centerBandPx": {"x": 90, "y": 70},
  "targetAreaFraction": {"min": 0.08, "max": 0.25},
  "motionPolicy": {
    "maxDragPxPerAction": 120,
    "maxCumulativeDragPx": 1440,
    "maxHoldMsPerAction": 250,
    "maxCumulativeHoldMs": 3000,
    "maxActions": 24,
    "maxDurationSec": 180
  },
  "outDir": "/tmp/pico-render/navigation/run-001"
}
```

Output is a discriminated execution result:

```json
{
  "executionStatus": "stopped",
  "achievedClaims": ["target_visible"],
  "stopReason": "budget_exhausted",
  "applicationRuntimeBinding": {"serial": "emulator-5554", "observedStageStyle": "Mixed", "effectiveSceneDriftPolicy": {}},
  "target": {"snapshotId": "...", "traceId": "...", "selectorReceipt": {}},
  "actions": [
    {
      "seq": 1,
      "request": {"kind": "drag", "dxPx": 120, "dyPx": 0},
      "ack": {"status": "applied", "windowId": 123, "bindingMethod": "single-online-serial-plus-matching-discovery-plus-single-window"},
      "settle": {"status": "settled", "captureSha256": "..."}
    }
  ],
  "captures": {"guideOff": {}, "acquisition": [], "finalDiagnostic": null, "finalClean": null},
  "lookObligations": ["open the final available clean frame"]
}
```

`executionStatus` is `completed`, `stopped`, or `error`; `achievedClaims` independently retains
`target_visible`, `target_centered`, and/or `free_camera_approached`. `stopReason` is one of
`objective_satisfied`, `ambiguous_target`, `label_absent`, `guide_not_acquired`, `unsettled`,
`scene_drift`, `budget_exhausted`, `ambiguous_host_window`, `unsupported_backend`, `input_failed`,
`binding_failed`, or `cleanup_failed`. Every action records requested units, clamp applied,
acknowledged endpoint/window, and settle receipt. No result field is named `arrived`.

The tool earns `structural` for action and scene-query receipts. If its exact waypoint frames later
pass a new producer-owned image predicate **and** its MR-diversity calibration, producer receipt,
and actual two-color uniqueness are implemented and measured, that exact predicate becomes eligible
for `auto_judged`; those prerequisites are **UNVERIFIED**, so phase-1 output is capped at
`structural` before LOOK. A vision-capable reviewer may record `vision_verified` only for visible
pixels after opening the exact returned frame. Emulator output cannot earn `device_verified`.

### 4.4 Full surface: `assert_scene_relation`

```json
{
  "serial": "emulator-5554",
  "scenario": {
    "packageName": "com.example.app",
    "expectedBuildReceiptId": "...",
    "expectedStageStyle": "Mixed",
    "expectedRootContainer": "stage",
    "sceneDriftPolicy": {"count": "advisory", "maxTransformDeltaM": 0.01, "maxTransformDeltaDeg": 1, "maxExtentDeltaM": 0.01, "topology": "strict"}
  },
  "subject": {"entity": "settings-panel"},
  "relation": "attached_to",
  "target": {
    "label": "WALL_ART",
    "selector": {
      "kind": "nearest_to_subject",
      "maxDistanceM": 3,
      "minSeparationM": 0.10
    }
  },
  "tolerance": {
    "maxSurfaceGapM": 0.04,
    "minProjectedOverlap": 0.70,
    "maxNormalAngleDeg": 12
  },
  "countPolicy": {"mode": "advisory", "acceptedRange": {"min": 1, "max": 4}},
  "samplingPolicy": {"maxSkewMs": 50, "maxTransformDriftM": 0.01, "maxTransformDriftDeg": 1},
  "captureMode": "clean_and_diagnostic",
  "outDir": "/tmp/pico-render/relations/wall-art-panel"
}
```

The tool first acquires a versioned subject transform/bounds receipt, injects its real receipt ID
into the selector receipt, and only then evaluates a subject-dependent selector. Output is `PASS`,
`FAIL`, or `ESCALATE` and includes `applicationRuntimeBinding` with the effective scenario/drift policy,
bridge transaction/revision ID, monotonic timestamps, anchor snapshot ID, subject receipt ID,
candidate scores, ambiguity rule, semantic-alignment status, signed gap, overlap, normal-angle
measurements, `countStatus`, sampling skew/drift, and a producer-authored geometry predicate.
`countPolicy` defaults to `advisory`; strict count drift fails only when explicitly requested.

The output also writes a structural relation manifest whose hash links the geometry receipt and two
separate `captureRef` values. The current ledger accepts one image artifact per entry and the device
path re-captures one looked artifact (`src/ledger.ts:536-558,813-877`), so paired clean/diagnostic
frames cannot atomically promote the hidden relation. Until a multi-artifact producer exists, record
one structural relation entry plus separate hash-linked image entries. The SDK-label and geometry
predicate remains `structural` on every backend. A calibrated producer may separately earn
`auto_judged` for only the visible overlay predicate; a LOOK may separately earn `vision_verified`
for each visible frame; on hardware that pixel-only attestation may separately earn
`device_verified` after live identity and same-serial byte equality. No image tier promotes the
hidden label, coordinate frame, or metric gap.

The literal claim “the panel is ON the WALL_ART band” is accepted only when the relation name and
tolerances are explicit; `attached_to` is preferable for a vertical band. Mixed-label anchors whose
semantic-element alignment is unknown return ESCALATE.

### 4.5 Doors surface: compatible `pico_look` extension

Keep the zero-input call as today's canonical capture. Add an optional union:

```json
{
  "goal": "walk to the table and look at it",
  "scenario": {
    "packageName": "com.example.app",
    "expectedBuildReceiptId": "...",
    "expectedStageStyle": "Mixed",
    "expectedRootContainer": "stage",
    "sceneDriftPolicy": {"count": "advisory", "maxTransformDeltaM": 0.01, "maxTransformDeltaDeg": 1, "maxExtentDeltaM": 0.01, "topology": "strict"}
  },
  "target": {"label": "TABLE", "selector": {"kind": "largest_horizontal", "minUpDot": 0.85, "ambiguity": {"metric": "area_ratio", "minSeparation": 0.15}}},
  "objective": "inspect",
  "serial": "emulator-5554",
  "budget": {"actions": 24, "timeSec": 180}
}
```

The typed `target` is authoritative; `goal` is retained as unverified descriptive context and is not
silently parsed into a selector. A goal-bearing call without `target` returns `needs_target` plus a
typed scaffold. With a target, the Door calls the full-surface query/navigation tools and returns
the settled final capture plus trace summary. It does not expose raw CGEvent pixels by default.
This preserves the current tool count and today's zero-input capture behavior
(`src/doors.ts:417-425`); goal-bearing calls add the proposed navigation behavior.

### 4.6 Hardware replacement: `device_observation_session`

The input is a discriminated session lifecycle:

```json
{
  "action": "prepare",
  "serial": "PICO_DEVICE_SERIAL",
  "scenario": {
    "packageName": "com.example.app",
    "expectedBuildReceiptId": "...",
    "expectedStageStyle": "Mixed",
    "expectedRootContainer": "stage",
    "sceneDriftPolicy": {"count": "advisory", "maxTransformDeltaM": 0.01, "maxTransformDeltaDeg": 1, "maxExtentDeltaM": 0.01, "topology": "strict"}
  },
  "target": {"label": "TABLE", "selector": {"kind": "largest_horizontal", "minUpDot": 0.85, "ambiguity": {"metric": "area_ratio", "minSeparation": 0.15}}},
  "privacy": {"consentReceipt": "external-id", "controlledTestRoom": true, "localOnly": true, "retentionHours": 24}
}
```

`prepare` returns `status:"prepared"|"ambiguous"|"unsupported"|"privacy_blocked"|"error"`,
`sessionId`, `applicationRuntimeBinding` with effective scenario/drift policy, selected
snapshot/target, and a plain wearer instruction. It never
claims which direction to turn unless a separately validated pose source exists.

```json
{
  "action": "capture",
  "sessionId": "...",
  "outPath": "/external/session/device-look.png",
  "stabilityPolicy": {"kind": "byte_exact", "maxTries": 6, "intervalMs": 700}
}
```

`capture` returns `status:"captured"|"unsettled"|"capture_failed"|"binding_changed"`, one
`captureRef`, stability attempts, current scene revision, and LOOK obligations. An unmeasured
hardware stability policy fails closed.

```json
{"action": "close", "sessionId": "...", "outcome": "completed"}
```

`close` returns `status:"closed"|"error"`, the immutable session-manifest path/hash, all capture and
scene references, privacy disposition, and separate structural/pixel evidence obligations. No
action applies motion because the user's head is the camera. H1 is blocked unless the run uses a
controlled room, explicit consent, local-only storage, and a declared deletion/retention policy.

## 5. Goal-directed emulator controller

The phase-1 controller is a bounded state machine:

1. **Bind runtime.** Resolve one adb serial, its matching gRPC discovery record, package/build
   identity, observed stage style, output directory, and—before any look action—the serial-to-qemu
   window binding. A serial/window mismatch or multiple unbound qemu windows stops the run.
2. **Query.** Poll an unfiltered semantic mesh to readiness, then match LABEL, apply a geometric
   selector, and hash the normalized snapshot. `not_ready`, `label_absent`, and `ambiguous_target`
   remain distinct and all stop before camera input.
3. **Prepare guide.** Capture a guide-off baseline. Ask the debug bridge to render a trace-local
   two-color fiducial on the selected anchor and return an acknowledgement bound to the snapshot and
   bridge revision IDs.
4. **Observe.** Call `capture_settled`, verify guide-off/on delta, then run the two-key detector on
   its immutable bytes.
5. **Acquire.** If absent, execute a bounded series of small horizontal right drags. Settle and
   observe after every drag. Never infer a completed 360-degree sweep from accumulated pixels.
6. **Center.** Convert the guide bounding-box center error into one clamped relative drag. Settle and
   re-observe; reduce the gain after an overshoot sign change.
7. **Approach.** This state is disabled until hold-duration-to-displacement and guide
   projection/occlusion behavior are measured. Once enabled, only when vertical error is inside the
   guard, issue one clamped short `w` hold, settle, and measure guide-area/shape change. If it shrinks
   twice, leaves the guard, disappears, or the target exceeds its drift policy, stop and re-query
   rather than compounding motion.
8. **Conclude.** Require the guide center and area to remain inside their bands on a final settled
   capture. Hide the guide, request no backend action, capture a clean frame, and return both with
   `sameViewEvidence`; do not claim actual pose equality without a pose/tick receipt.
9. **Budget.** Stop on action, duration, settle, retry, or divergence limits. Always attempt keyup in
   a finally path; never continue after uncertain input acknowledgement.

This state machine is visual servoing around a semantic beacon. It is not navigation through a
collision map. Q/E may support explicit altitude correction, but phase 1 does not automatically
infer altitude. Because move calibration, drag-to-angle conversion, and guide scale-to-distance are
**UNVERIFIED**, all gains and hard clamps remain explicit configuration in the trace. Phase 1C may
ship `target_centered` while leaving approach disabled.

## 6. Object-level semantic assertions

### 6.1 Runtime matching contract

For each assertion:

1. open a bridge transaction/revision and record a monotonic timestamp;
2. poll a fresh unfiltered scene snapshot to readiness, then collect every anchor containing LABEL;
3. request a versioned subject transform/world-bounds receipt inside that transaction;
4. evaluate the selector—using that receipt when it is subject-dependent—and refuse ambiguity
   inside the configured, dimensioned margin;
5. require validated semantic-element alignment for label-specific triangle relations;
6. compute the relation and render the diagnostic under the same bridge revision;
7. capture clean/diagnostic frames with sampling timestamps and no requested backend action between
   them; and
8. re-query after capture, geometrically re-match, and report exact plus policy-bounded drift as
   ESCALATE when the sampling or drift policy is exceeded.

The subject never binds to a persisted anchor UUID, index, or expected total count. Count ranges are
diagnostics and scenario bounds, not identity. `countPolicy` is advisory by default and is reported
separately from the relation verdict.

### 6.2 Relation math

Phase 2 should implement named predicates rather than a generic natural-language truth function:

- `supported_by`: subject bottom-to-surface signed gap, overlap on the support plane, upward normal.
- `attached_to`: subject back-to-surface signed gap, projected overlap, opposing normal.
- `within_band`: subject center or declared footprint lies within a target mesh region plus margin.
- `in_front_of`: signed separation along target normal and projected overlap.

The triangle-level calculation is the authority only when the lossless payload's semantic assignment
domain and vertex/index alignment are fixture-validated. An anchor-level label plus triangles is not
enough to identify a WALL_ART subregion. Bounds-only fallback must label its result `approximate`
and remain structural. A predicate with unknown semantic alignment, missing geometry, degenerate
normals, multiple near-equal targets, transaction mismatch, excessive sampling skew, or drift beyond
policy returns ESCALATE.

For “panel on WALL_ART,” a valid receipt therefore says, for example: “`attached_to` one runtime
WALL_ART-labeled mesh, 0.021 m gap, 0.84 projected overlap, 4.1° normal difference, label count 3
with advisory count status inside 1..4.” The count is not part of identity unless the scenario
explicitly requests strict count policy. The receipt does not claim that the SDK's WALL_ART label is
objectively correct about the physical room; semantic-label accuracy is **UNVERIFIED**.

### 6.3 Bound visual witness

After semantic-element alignment is validated, the app renders the chosen semantic region/band in
key A and the subject outline in key B, with a structured trace-local fiducial. The eye measures:

- both keys present;
- subject and band bounding-box overlap inside a declared range;
- edge gap inside a declared pixel range; and
- guide/subject persistence across the settled pair.

The existing MR color lane already provides immutable per-key detections and refuses weak palettes
(`src/eye.ts:97-137,254-277`). The new semantic-overlay expectation must require two actually
different keys, a guide-off/on delta, producer-author the exact visible measurement, and pass an MR
background-diversity calibration before it becomes eligible for `auto_judged`. Those new producer
and calibration prerequisites are **UNVERIFIED**. Caller prose remains context, following the
current judge boundary (`src/eye.ts:201-209,414-450`).

The diagnostic overlay can show *why* geometry passed or failed; it cannot prove the clean app looks
good. The clean capture still needs a LOOK. Conversely, a visually plausible clean capture cannot
prove the hidden anchor label or metric gap; retain the structural manifest. Each image claim is
separate until a multi-artifact ledger producer exists.

## 7. Visual confirmation evolution

The navigation and relation stack enables four new eye predicates:

| Proposed predicate | Inputs | PASS means | Evidence ceiling before LOOK |
| --- | --- | --- | --- |
| `waypoint_target_visible` | immutable guide-off/on frames, two-color fiducial | the selected debug guide is detected | `structural` until producer + MR calibration are measured (**UNVERIFIED**); then eligible for exact-predicate `auto_judged` |
| `waypoint_target_centered` | fiducial bbox, center band | the guide center lies in the declared band | `structural` until producer + MR calibration are measured (**UNVERIFIED**); then eligible for exact-predicate `auto_judged` |
| `waypoint_approach_trend` | ordered immutable frames | guide projection changed within the declared trend/guard predicate | `structural` until projection behavior, producer, and MR calibration are measured (**UNVERIFIED**); then eligible for exact-predicate `auto_judged` |
| `semantic_relation_overlay` | subject key, semantic key, overlap/gap bands, structural manifest | the exact visible overlay predicate passed, not the hidden relation | `structural` until producer + MR calibration are measured (**UNVERIFIED**); then eligible for exact-predicate `auto_judged` |

Each is a new producer-owned acceptance shape, not a way for callers to mint arbitrary semantic
claims. The current ledger accepts `auto_judged` only from the calibrated producer
(`src/ledger.ts:592-603,640-647`). Implementation must either extend `visual_judge` and its signed
receipt or add an equally restricted producer path; a plain `record_verification` call is rejected.
No proposed predicate is `auto_judged` merely because this design names it.

Waypoint capture review adds a visual-judge lane, not a replacement for LOOK. A reviewer should
inspect the final clean frame, at least one acquisition frame, and the diagnostic relation frame.
The trace should make every other frame available for audit and identify skipped LOOK obligations.

## 8. Hardware is a first-class design axis

On a PICO headset the user’s head is the camera. The host must not post CGEvents, send emulator walk
keys, restore emulator snapshots, or report autonomous navigation. The replacement is a guided
observation session: select a semantic target, ask the wearer to orient or move safely, capture what
the device renders, and bind the scene/capture receipts.

| Primitive | macOS emulator | Non-macOS emulator | PICO hardware |
| --- | --- | --- | --- |
| rendered capture | adb `screencap` | adb `screencap` | adb path is code-routed; pixels/timing **UNVERIFIED** (`docs/DEVICE_VERIFICATION.md:143-160`) |
| semantic query | Agent Bridge + simulated SDK mesh | candidate bridge path | proposed same payload schema; physical-room results **UNVERIFIED** (`docs/DEVICE_VERIFICATION.md:143-160`) |
| look rotation | qemu CGEvent right drag | no current backend | user's head; no injected rotation |
| translation | proposed serial/discovery-bound gRPC WASD/QE | focus delivery and rendered motion **UNVERIFIED** | wearer movement; no emulator key path |
| settle | two byte-identical frames | candidate same policy | policy **UNVERIFIED** for live passthrough/head motion |
| automated eye | saved-file analysis | saved-file analysis | saved-file analysis; calibration on device frames **UNVERIFIED** (`docs/DEVICE_VERIFICATION.md:155-156`) |
| evidence ledger | structural/auto/vision | structural/auto/vision | device protocol exists but end-to-end run **UNVERIFIED** (`docs/DEVICE_VERIFICATION.md:3-12,159-161`) |
| snapshot reset | emulator snapshot | emulator snapshot | emulator-only; app-owned reset fixture required (`docs/DEVICE_VERIFICATION.md:159`) |

Hardware phase gates must therefore be present in every roadmap phase:

- Phase 1 defines backend capability negotiation and refuses motion on `pico_device_guided`.
- Phase 2 makes semantic assertion payloads serial-neutral and records coordinate-frame metadata.
- Before H1, establish controlled-room consent, local-only evidence, retention/deletion, and bridge
  command security. Phase 3 then runs the first real-device capture/LOOK/ledger experiment before
  claiming portability.
- Store hardening adds app-owned deterministic reset, safe wearer instructions, privacy controls,
  and device performance scenarios instead of relying on VM snapshots.

A device debug spectator camera could be useful for deterministic diagnostics, but it would not be
the wearer’s head view and must not inherit `device_verified` perspective claims. Availability of
head-pose telemetry, a stable casting API, scene-query fidelity, safe automated instruction timing,
and any app-controlled device camera are **UNVERIFIED**.

## 9. Store-application trajectory

The stack must grow from an interactive demo into repeatable scenario infrastructure:

1. **Versioned scenario manifests.** Package/build identity, stage style, environment prerequisites,
   app reset command, semantic selectors, action budgets, visual predicates, accepted label/count
   ranges, and evidence ceilings are code-reviewed data.
2. **App-owned deterministic reset.** Large apps cannot depend on a whole-VM snapshot on hardware.
   Debug builds need a safe reset route for account state, scene, seed, and tutorial position; the
   release build must exclude the bridge at compile time or protect every command with an
   authenticated/signature-checked debug capability. Release exclusion is the default.
3. **Bounded traces.** Every run retains only declared key frames plus hashes/metrics for the rest,
   has a time/action/storage budget, and records crash/process/performance context.
4. **Semantic contracts.** Tests select surfaces by label plus geometry and tolerate measured ranges;
   they do not fossilize emulator anchor UUIDs or counts.
5. **Two-view evidence.** Clean captures protect customer appearance; diagnostics explain placement.
   A release decision requires LOOKs at exact frames, not just relation math.
6. **Cross-environment matrix.** Mixed is primary; Full remains a required row with its own enclosure,
   occlusion, and hardware caveats. Stage style is explicit in every receipt.
7. **Portable evidence roots.** A completed recapture found that a receipt created under one ledger
   root could not be bound from another until the original roots were restored
   (`/Users/sushantsrikrish/pico-sdk6-validation/evidence/golden-recapture-2026-08-28/run-notes.md:121-143`).
   Store-scale orchestration needs one session-owned receipt/evidence root and an explicit archive
   contract.
8. **Privacy and retention.** Room meshes and MR captures may reveal a user's environment. Their
   redaction, encryption, consent, retention, and upload policy are **UNVERIFIED** product/security
   prerequisites and must be decided before live-user or store telemetry.
9. **Performance isolation.** Debug overlays, mesh export, capture cadence, and eye processing need
   measured budgets so verification instrumentation does not distort the app. Those budgets are
   **UNVERIFIED**.

## 10. Ranked roadmap by value and effort

Effort is an engineering estimate, not repository evidence. “Days” means focused engineer-days,
excluding SDK/vendor waits and hardware access.

| Rank | Phase | Value | Effort | Buildable outcome | Honest maximum evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | **1A — settle + serial correctness** | Very high | **S, 2–3 days** | Shared `capture_settled`; discovery-safe reconnect; serial-to-window refusal/binding; timeout/action receipts; focused tests | structural; LOOK can separately support returned-frame pixels |
| 2 | **1B — typed semantic snapshot** | Very high | **M, 4–6 days** | Versioned lossless bridge payload + `query_scene_anchors`; readiness polling; raw semantic assignments; snapshot/drift receipts; ambiguity/range reporting | structural |
| 3 | **1C — bounded target acquisition** | High | **L, 7–10 days** | Two-color guide + `navigate_to_scene_target`; acquire/center; calibrated approach optional; optional `pico_look` goal; clean + diagnostic trace | structural until new eye producer/calibration; LOOK can separately earn vision for pixels |
| 4 | **2 — object-relation assertions** | Very high | **L, 8–12 days** | Validated semantic alignment + relation engine; `assert_scene_relation`; structural manifest; separate clean/diagnostic evidence; drift/skew guard | hidden relation stays structural; separately calibrated overlay may earn auto and each LOOKed frame may earn vision |
| 5 | **3 — scenario regression lane** | High | **M, 5–8 days** | Scenario manifests, selected key-frame review, trend/drift reports, snapshot/app-reset adapters | same as each underlying observation |
| 6 | **H1 — first real PICO proof** | Critical | **M/L, 5–8 days after privacy controls and hardware access** | controlled-room `device_observation_session`; one scene query, capture, LOOK, and same-serial pixel-evidence record; documented failures retained | hidden scene claim structural; visible pixels device only if every existing gate passes |
| 7 | **4 — store hardening** | Critical later | **XL, 2–4 weeks** | privacy/retention, app reset, release/debug separation, CI matrix, perf budgets, evidence archive contract | scenario-dependent; never globally promoted |

The top three phase-1 build items are intentionally foundations before relation math: unify settled
observation, make semantic snapshots trustworthy, then add bounded navigation. Phase 1C can ship
`target_centered` before approach if the pitch guard proves too weak.

## 11. Future implementation tasks and tests

No task below is authorized in this design wave.

### Task 1: Extract settled capture and repair serial binding

**Future files:** `src/cameradrive.ts`, a new `src/observation.ts`, `src/index.ts`, and focused tests.

- Move settle capture into a reusable function with injected capture/sleep/hash dependencies.
- Thread `serial` into `getClient(undefined, serial)` on the initial and reconnect paths.
- Remove or constrain the unauthenticated/default-port recovery path; re-read discovery and retain
  endpoint identity plus only token presence/fingerprint.
- Bind an adb serial to the intended qemu host window. The only fallback requires exactly one online
  emulator serial, one matching discovery endpoint, and one eligible window; return
  `ambiguous_host_window` otherwise.
- Guarantee paired keyup and report uncertain release.
- Test immediate equality, delayed equality, timeout with last frame, capture failure, two endpoints,
  token-present/token-absent/missing discovery, mismatched serial, reconnect, and two qemu windows.
- Preserve existing `capture_orbit`/`capture_multiview` output compatibility.

### Task 2: Add a lossless semantic snapshot bridge

**Future files:** generated Agent Bridge code, `src/sense.ts`, a new host parser/schema, registration,
and deterministic fixtures.

- Emit versioned JSON in bounded chunks or through a file/pull route; never depend on one logcat line.
- Establish unfiltered non-empty readiness before label filtering and sample consecutive reads.
- Preserve full transform, coordinate metadata, raw labels, vertices, indices, and raw semantic
  assignments in a hashed external geometry artifact.
- Prove the semantic assignment's vertex/index/triangle alignment with fixtures; anchor-level
  deduplicated labels remain selectors only until then.
- Bind observed stage style, build identity, bridge revision, and monotonic timestamps.
- Produce snapshot-local IDs; mark runtime UUID diagnostic-only.
- Test raw semantic alignment, anchor-level label dedupe, truncation, unfiltered readiness versus
  label absence, unopened Stage, updates/removals, float jitter/drift policy, environment
  re-selection variance, and ambiguous selectors in Mixed and Full.

### Task 3: Add debug guide and visual-servo controller

**Future files:** debug-only generated app bridge/overlay, `src/navigation.ts`, `src/eye.ts`, Door
adapter, and image/action fixtures.

- Gate the two-color guide behind a compile-time-excluded or authenticated debug feature and
  trace-scoped command; require a guide-off/on delta.
- Implement acquire, center, divergence, budget, and cleanup states. Keep approach disabled until
  translation-step and guide-projection calibration pass.
- Keep action gains, per-step/cumulative clamps, endpoint/window acknowledgements, and achieved
  claims explicit in output; do not add absolute pose fields.
- Add eye expectations only through immutable producer bytes.
- Test target absent/present, overshoot, inertia, shrinking/growing guide, pitch guard, scene drift,
  unsupported backend, and cleanup after failure.

### Task 4: Add relation engine and paired evidence

**Future files:** pure geometry module, bridge subject-bounds payload, overlay renderer, assertion tool,
ledger producer contract, and geometry/image fixtures.

- Implement relation predicates as pure functions first.
- Acquire the subject receipt before subject-dependent selection; bind one bridge transaction and
  sampling timestamps to subject, anchor snapshot, overlay acknowledgement, and captures.
- Bind subject, anchor snapshot, clean frame, diagnostic frame, and build receipt through a
  structural manifest. Until a multi-artifact producer exists, persist separate hash-linked image
  entries and never promote the hidden relation through an image tier.
- Test vertical/horizontal surfaces, triangle versus AABB fallback, ambiguous labels, changed snapshot,
  semantic-alignment unknown, tolerance/count policies, coordinate-frame/revision mismatch,
  sampling skew, bounded float drift, and immutable-frame races.

### Task 5: Exercise hardware without emulator assumptions

**Future files:** device backend and protocol tests plus external evidence only.

- Capability-negotiate capture/query/motion independently.
- Require controlled-room consent, local-only evidence, a deletion/retention plan, and secured debug
  commands before collecting any room geometry or capture.
- Run one attached-device query and stable-frame experiment; retain negative results.
- Require a human/wearer safety checkpoint before physical movement.
- LOOK before recording, then exercise the existing live identity and same-serial recapture path.
- Do not add a bypass for black, changing, or unavailable device frames.

## 12. Acceptance and evidence matrix

| Capability | Required execution evidence | Maximum class before a LOOK | Upgrade condition |
| --- | --- | --- | --- |
| successful settled capture | two consecutive byte-equal capture hashes plus exact serial/runtime identity | structural | LOOK may separately verify returned pixels; it does not promote settlement |
| settle timeout execution | explicit timeout, attempts, exact identity, and last valid frame if any | structural failure receipt | LOOK may verify only the last frame's pixels, never settlement |
| semantic snapshot | bridge payload, retry/state trace, normalized snapshot hash, runtime label histogram | structural | no visual promotion; it proves data, not appearance |
| target acquisition | selected snapshot + guide-off/on frames + action/settle trace | structural until new producer/calibration are measured (**UNVERIFIED**) | LOOK may separately earn vision for each frame's visible pixels |
| free-camera approach | calibrated action/settle trace + bounded guide-projection predicate | structural until motion/projection producer calibration is measured (**UNVERIFIED**) | LOOK supports only visible “appears closer,” not metric arrival |
| semantic relation | subject receipt + lossless mesh snapshot + validated semantic alignment + named geometry predicate + structural manifest | structural, always, for hidden label/geometry | no image tier promotes it; overlay/clean pixels have separate entries |
| semantic overlay pixels | separate immutable diagnostic frame linked to structural manifest | structural until new producer/calibration are measured (**UNVERIFIED**) | LOOK may earn vision for visible overlay pixels only |
| emulator scenario | build receipt + above evidence | class of each observation, never device | cannot upgrade emulator bytes to device |
| hardware scene observation | live identity + scene query/geometry receipt | structural | no pixel tier promotes hidden SDK labels or geometry |
| hardware rendered pixels | live identity, one exact looked frame, and pixel-only attestation | structural/auto/vision as independently earned | fresh same-serial equal capture + all device fields → device for those pixels only |

A phase is accepted only when its negative cases fail closed, its final report names every remaining
LOOK obligation, and an independent reviewer can reproduce each claim from a file/line citation or
an immutable external evidence path.

## 13. Complete known UNVERIFIED register

Every first-column entry is explicitly **UNVERIFIED** and remains blocking for the capability named
in that row until a future authorized run measures it. A lower phase may proceed when its own
prerequisites are grounded.

| Unverified prerequisite or claim | Affects | Required future proof |
| --- | --- | --- |
| **UNVERIFIED:** Exact free-camera translation decomposition when the view has pitch | approach | Controlled pitched-view moves with settled before/after captures and retained trace. |
| **UNVERIFIED:** Hold duration/repeat to displacement, including the effect of focus and inertia | approach | Repeated short-step measurements across pitch/yaw, emulator versions, and hosts. |
| **UNVERIFIED:** Guide area/shape changes monotonically enough with forward distance to control approach | approach | Known-distance trials covering perspective, clipping, occlusion, and guide geometry. |
| **UNVERIFIED:** Stable drag-pixel-to-yaw/pitch calibration across emulator version, window size, host scaling, and repeated runs | acquire/center | Calibration matrix; until then gains remain relative and adaptive. |
| **UNVERIFIED:** An adb serial can be bound to the qemu window receiving CGEvents | macOS look safety | Measured serial-to-window discovery/binding; fallback requires one online serial, its one matching discovery endpoint, and one eligible window. |
| **UNVERIFIED:** Non-macOS gRPC key delivery focuses the correct window and moves the rendered camera | non-macOS translation | Retained before/after settled captures on each host backend. |
| **UNVERIFIED:** A non-macOS autonomous look backend exists | platform parity | Rendered before/after proof on each proposed backend. |
| **UNVERIFIED:** Any absolute free-camera pose API exists outside the tracked/loaded surfaces | metric navigation | Installed-proto/API inventory plus observed rendered effect; current repo offers no grounded path. |
| **UNVERIFIED:** Collision-free route planning or physical “walking” semantics | navigation | Camera pose, collision geometry alignment, planner, and obstacle trials. Not a phase-1 claim. |
| **UNVERIFIED:** Debug guide rendering works at an arbitrary runtime mesh anchor | navigation | Built app, bridge acknowledgement, and LOOKed guide capture. |
| **UNVERIFIED:** Two truly distinct guide colors plus guide-off/on delta uniquely identify the fiducial across MR backgrounds | navigation/auto evidence | Diverse labeled corpus, false-positive analysis, and repeated scene trials. |
| **UNVERIFIED:** Raw mesh semantic assignments align to vertices, faces, triangles, or regions in the assumed way | label-specific relation | Lossless fixtures validating assignment count/domain against vertices and indices; mixed-label unknowns ESCALATE. |
| **UNVERIFIED:** Subject world bounds and scene mesh share one coordinate frame for Mixed and Full | relation assertions | Numeric fixtures plus rendered diagnostic alignment in both stage styles. |
| **UNVERIFIED:** Subject, mesh, overlay, and captures can be sampled under one coherent bridge revision and drift bound | relation assertions | Transaction/revision/timestamp tests including concurrent scene and subject motion. |
| **UNVERIFIED:** Clean and diagnostic captures have equal pose when no backend action is requested between them | paired visual witness | Pose/tick receipt or measured drift bound; especially required on hardware. |
| **UNVERIFIED:** Geometric selector features remain stable across reboots, SDK versions, other environments, and hardware rooms | scene selection | Per-environment/reboot selector trials; current consistency is one-session evidence only. |
| **UNVERIFIED:** Runtime semantic labels correspond to physical truth rather than SDK classification | claim wording | Independent room ground truth and labeled-anchor validation; until then say “SDK-labeled.” |
| **UNVERIFIED:** Measured Museum/Mesume label/count ranges generalize to other environments, boots, SDK versions, or hardware rooms | scene selection | Per-environment evidence; never reuse Museum bounds globally. |
| **UNVERIFIED:** Programmatic, deterministic selection of Museum/Mesume or other host environments | scenario setup | Working API or host automation proof; current external evidence found the host dialog was the only working switch (`/Users/sushantsrikrish/pico-worlds-in-a-room/evidence/inventory-comparison-2026-08-10.md:9-21`). |
| **UNVERIFIED:** Triangle-level subject-to-anchor accuracy and tolerances are suitable for store acceptance | relation assertions | Synthetic fixtures plus measured app scenes with known geometry. |
| **UNVERIFIED:** App-reported build, stage style, root-container, and bridge revision are trustworthy and consistently available | runtime binding | Mixed/Full integration fixtures and mismatch tests. |
| **UNVERIFIED:** General snapshot determinism beyond the one proven showcase run | regression | Repeated save/load/hash trials per app, environment, and emulator version. |
| **UNVERIFIED:** Two byte-identical frames are obtainable and meaningful for animated apps or live passthrough | settle | Dynamic-scene study; define a measured alternate stability metric if exact bytes cannot settle. |
| **UNVERIFIED:** New waypoint/relation eye checks are calibrated against MR background diversity | auto evidence | Labeled image corpus, false-positive/negative analysis, thresholds, and audit sampling. |
| **UNVERIFIED:** A producer/ledger contract can bind a structural relation manifest plus multiple images atomically | relation evidence | Multi-artifact schema, immutable-byte tests, report downgrade behavior, and migration plan. Until then use separate entries. |
| **UNVERIFIED:** Hardware scene-understanding availability, readiness, labels, geometry, and coordinate alignment | hardware relation | Attached PICO query receipts and paired diagnostic LOOKs. |
| **UNVERIFIED:** Hardware adb screencap visibility, timing, stability, and equality during ledger recapture | hardware evidence | Retained frames and successful/failed protocol transcript on the exact device. |
| **UNVERIFIED:** A stable hardware casting/recording API exists for cases where adb screencap is black or unstable | hardware visual fallback | API/source citation plus retained cast frames, timing, identity binding, and comparison against wearer-visible output; distinct from any debug spectator camera. |
| **UNVERIFIED:** Actual PICO identity values pass the current classifier and the first end-to-end `device_verified` pixel write | hardware evidence | Live probe plus same-serial, same-byte recorded row. |
| **UNVERIFIED:** Device head-pose telemetry is usable for agent guidance | hardware navigation | SDK/API citation and measured pose-to-capture correlation. |
| **UNVERIFIED:** Any safe mechanism exists for an agent to move the user's head or body | hardware navigation | Out of scope by default; require product, safety, and human-factors authorization. |
| **UNVERIFIED:** A device debug spectator camera exists and has a known relationship to the wearer view | hardware diagnostics | Implemented debug camera plus paired wearer/spectator captures; never assume equivalence. |
| **UNVERIFIED:** Hardware Full Space Guardian behavior | Full hardware lane | Real-device execution; the current warning is partner-stated, not measured (`DESIGN.md:108-117`). |
| **UNVERIFIED:** Device-guided observation instructions are usable and safe | hardware UX | Wearer study and explicit safety review. |
| **UNVERIFIED:** Arbitrary large applications can expose reset, subject bounds, and debug overlays without architectural conflict | store trajectory | Integration spike in a representative application. |
| **UNVERIFIED:** Debug instrumentation has acceptable CPU/GPU, memory, battery, capture, and storage overhead | store trajectory | On-emulator and on-device performance measurements with declared budgets. |
| **UNVERIFIED:** Compile-time release exclusion or authenticated debug-bridge commands are implemented correctly | store security | Release-binary inspection plus negative authorization tests. |
| **UNVERIFIED:** MR room-mesh/capture privacy, consent, encryption, retention, deletion, and upload policy | store trajectory | Product/security/legal decision and implementation review before H1. |
| **UNVERIFIED:** Receipt/ledger archives remain portable across hosts and roots | store CI | Cross-root archive/restore test that resolves the observed binding failure without manual mutation. |
| **UNVERIFIED:** Navigation and relation success on the currently running emulator | all proposed behavior | Deliberately not tested in this read-only design wave; future authorized execution only. |

## 14. Rollout and rollback policy

Implement behind an explicit experimental capability flag and keep today's zero-input `pico_look`
and existing `capture_orbit`/`capture_multiview` behavior compatible. Phase 1A may land independently.
Phase 1B must land before 1C; phase 2 must depend on the same snapshot schema rather than a parallel
mesh parser. Hardware backends must advertise absence of motion as a supported, expected state.

Tests import compiled output and package scripts provide no general pretest build hook
(`package.json:23-77`; representative imports: `test/eye.mjs:8-10`), so every future implementation
phase must rebuild `dist/` first. It must inspect any returned rendered frame before claiming visual
success (`AGENTS.md:18-29`) and keep captures/room meshes outside the repository. If a phase is
reverted, use a normal revert commit for its source changes and retain external failed-run evidence.
Never delete or rewrite ledger history; use its append-only correction path
(`src/ledger.ts:30-32,880-885`).
