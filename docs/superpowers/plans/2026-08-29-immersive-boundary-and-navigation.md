# Immersive Boundary and Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **DESIGN ONLY:** Do not execute this plan in this wave. A later, separately authorized wave may
> build apps, drive the emulator, import an APK, or touch PICO hardware. This document is the only
> tracked output of the present code-and-existing-evidence recon.

**Goal:** Build actual immersive test apps and determine whether an agent-driven walk causes an app
to leave its immersive environment, especially when Full Space is entered dynamically rather than
declared in the launcher manifest.

**Architecture:** Put one serial-bound relative-motion executor beneath two controllers. The first
controller runs a fixed, bounded boundary-characterization route; the later
`navigate_to_scene_target` controller performs visual servoing toward a semantic target. Both use
the existing gRPC key, macOS CGEvent look, and `capture_settled` primitives; application continuity
is extracted from existing receipt/query logic (`src/cameradrive.ts:187-348`;
`src/observation.ts:351-530`; `src/sceneanchors.ts:976-1072`). Neither controller owns a second
movement stack.

**Tech Stack:** TypeScript/Node MCP server; Kotlin/PICO Spatial SDK apps; AppSpec and existing native
generators; adb/logcat/dumpsys observation; emulator gRPC `sendKey`; macOS CoreGraphics right-drag;
PNG capture and the repository evidence ledger.

**Spec:** This plan implements the mission in the 2026-08-29 user brief and extends the approved MR
navigation design at
`docs/superpowers/plans/2026-08-28-mr-agent-navigation-and-scene-understanding.md:1-36`.

## Global constraints

- The current wave changes and commits only this document. It does not alter source, tests, briefs,
  manifests, packages, evidence, the emulator, or a device.
- A future execution wave starts with read-only `pico_doctor {}` and follows its exact fixes; only
  `pico_doctor {calibrate:true}` is the mutating doctor route (`AGENTS.md:15-16,70-74`).
- A visual statement becomes `vision_verified` only after a vision-capable reviewer opens the exact
  capture and limits the attestation to visible pixels (`AGENTS.md:18-29`).
- Black immersive adb pixels are inconclusive. They establish neither rendering failure nor a
  capture-path defect (`README.md:140-147`; `docs/DEVICE_VERIFICATION.md:68-77`).
- Every future run binds package, APK/build receipt, PID/start ticks, stage route, serial, boot
  identity, action receipts, logs, and captures. A filename or a foreground-looking frame alone is
  not app attribution; the native receipt already treats these as distinct structural facts
  (`README.md:112`; `src/nativefleetreceipt.ts:833-889`).
- All interfaces, tools, scenarios, thresholds, outcome names, tests, and roadmap items proposed
  below are **PROPOSED FUTURE CONTRACTS** unless a paragraph explicitly labels them current.

---

## 1. Research question, claims, and non-goals

The primary question is run-scoped:

> For one exact app build, stage-entry route, emulator/device identity, start state, movement route,
> and observation window, did the app remain visibly immersive, return to its own default Stage, or
> yield to the PICO home environment?

The result vocabulary is deliberately narrower than “the Guardian is fixed”:

- `retained_immersive_through_route` — the declared traversal witness was reached and every required
  observation retained the expected app sentinel.
- `returned_to_app_default_stage` — a dynamic secondary Full Stage disappeared but the same app's
  distinct manifest-root sentinel remained, with no app-owned close preceding the transition.
- `stage_self_closed_or_lifecycle_teardown` — an app-owned close marker preceded the changed frame,
  or a complete same-session/generation event sequence could not rule that path out; this is a
  confounded causal result, while any looked visual transition is reported separately.
- `ejected_to_system_home` — the app sentinel disappeared and a looked-at frame showed the PICO home
  environment, with structural state reported separately.
- `app_lifecycle_loss` — PID/start ticks, resumed component, crash scan, or app lifecycle changed;
  this is not silently relabeled as a boundary ejection.
- `no_ejection_within_observed_budget` — the route ended without ejection but did not establish its
  required traversal witness; this characterizes a budget, not boundary safety.
- `input_release_uncertain` — the bound runtime did not acknowledge keyup; later movement and
  automated recovery stop because held-input state is unknown.
- `capture_inconclusive`, `route_unsettled`, and `binding_lost` — evidence collection could not
  support a visual outcome.

This plan does not infer an absolute camera pose, physical collision-free travel, a universal
boundary radius, or a vendor root cause. The current movement surface is relative to current facing,
and the accepted navigation design already forbids `arrived`, `at_pose`, `walked`,
`collision_free`, and `world_localized` claims (`src/cameradrive.ts:20-34`;
`docs/superpowers/plans/2026-08-28-mr-agent-navigation-and-scene-understanding.md:52-59`).

The plan also does not automate a person or bypass a physical Guardian. Hardware work is a
consented, wearer-guided observation session; emulator free-camera controls are classified as
emulator-only (`docs/DEVICE_VERIFICATION.md:143-160`).

## 2. Verified current-state inventory

### 2.1 The workaround is a partner report, not a local measurement

The current README says the hardware Full-Space Guardian issue is partner-stated, PICO's fix is in
progress, and this repository has not measured it. It then records Fabian's 2026-08-12 emulator
comparison: a dynamically opened Full Stage walked out, while the same Editor-authored museum world
in a manifest-declared `DefaultStage` with `pico.spatial.stage.style=1` stayed visible during
extended WASD movement. The same paragraph says this machine has not replicated the comparison and
hardware still needs Safeguard validation (`README.md:172-180`).

Historical repository object `817fadc3852dc82a6a855d593617e05a669040f2` introduced that comparison
as “Partner-verified”; `git show --format=fuller --stat 817fadc` and
`git show 817fadc -- README.md` reproduce its one-file README diff. The current text instead says
“partner-reported” and explicitly says this machine has not replicated it (`README.md:172-180`). The
commit is documentation provenance, not a retained capture, log, or local run receipt.

The two stage mechanisms are distinct in current source:

- A launcher `DefaultStage` reads `pico.spatial.stage.style` from manifest metadata. The packaged
  skeleton documents values `1=Mixed`, `2=Progressive`, and `3=Full`
  (`appskeleton/app/src/main/AndroidManifest.xml:36-53`). `scaffold_spatial_app` accepts those values,
  and project generation substitutes the selected value into that manifest
  (`src/scaffold.ts:42-73`; `src/projectgen.ts:154-187`). The compiler passes
  `spec.meta.stageStyle` to the scaffold step (`src/compiler.ts:45-64`).
- A secondary Stage is declared in Kotlin and receives its style when
  `LocalSpatialNavigator.openStage(...)` is called. AppSpec accepts a secondary Stage style of Full,
  and, when configured with `style:"Full"`, the generator can emit `Stage(...)`, an
  `Open*OnEnter` default of `StageStyle.Full`, and the suspend `navigator.openStage(...)` call
  (`src/appspec.ts:60-75`; `src/containers.ts:221-240,289-320`). The explicit dynamic matrix row
  below is still a proposed build, not current runtime evidence.

The hypothesis to test is therefore **stage-entry route**, not “Full Space is always broken.” A
manifest-Mixed control is necessary because it is the exact partner-reported surviving route; a
manifest-Full row is necessary to separate Full immersion from dynamic entry.

### 2.2 Full-Space briefs already in the corpus

Twenty-two current brief files explicitly declare manifest `stageStyle: "3"`:

| Brief | Exact declaration |
| --- | --- |
| `affordance` | `briefs/affordance.json:8` |
| `ambient` | `briefs/ambient.json:8` |
| `atrium` | `briefs/atrium.json:8` |
| `boutique` | `briefs/boutique.json:8` |
| `calib` | `briefs/calib.json:9` |
| `console` | `briefs/console.json:8` |
| `crystals` | `briefs/crystals.json:8` |
| `dashboard` | `briefs/dashboard.json:8` |
| `gallery` | `briefs/gallery.json:8` |
| `inspection` | `briefs/inspection.json:8` |
| `knockdown` | `briefs/knockdown.json:8` |
| `museum` | `briefs/museum.json:8` |
| `narrative` | `briefs/narrative.json:8` |
| `orrery` | `briefs/orrery.json:8` |
| `ramenlos` | `briefs/ramenlos.json:8` |
| `ramenoccupancy` | `briefs/ramenoccupancy.json:8` |
| `ramenworld` | `briefs/ramenworld.json:8` |
| `showcase` | `briefs/showcase.json:8` |
| `spotcheck` | `briefs/spotcheck.json:8` |
| `stationsemantic` | `briefs/stationsemantic.json:8` |
| `studio` | `briefs/studio.json:8` |
| `worldtour` | `briefs/worldtour.json:8` |

These are AppSpec inputs, not proof that each retained a Full environment during a long walk. The
corpus's only template that hard-codes Full is the `knockdown` archetype, whose source explicitly says
that its Full proof path was not re-captured in Mixed (`src/templates.ts:112-130`).

### 2.3 What the Mixed flagship proved

Swan Mission Table explicitly declares a Mixed launcher Stage and a Stage root
(`briefs/swanmissiontable.json:2-10`). Its conformance path validates the AppSpec and generated
lifecycle/scene-understanding/wiring shape (`test/conformance.mjs:1302-1334`), while SpatialBench
checks that the generated panel remains scene geometry and that its authored palette reaches the
runtime Kotlin (`test/spatialbench.mjs:609-637`). The Agent Bridge source records that its revision-41
scene snapshot transport was exercised live with `com.fleet.swanmissiontable`, but labels geometry
and labels structural rather than visual evidence (`src/agentbridge.ts:703-754`).

That is a structural/compiler/runtime transport proof for the flagship Mixed lane, not a current
looked-at Mixed-frame proof. The older `mrtable` visual record is retained as
`provenance-broken`, and the README limits its present statement to structural fleet exercise
(`docs/claims/claims.json:3381-3408`; `README.md:118-120`). This plan will not upgrade either result.

### 2.4 Spatial Editor payload and artifact inventory

`PLUGINS.md` is a dated Spatial Editor/Android Studio surface recon. It describes an Editor project
as a JSON `.spatialproject`, `Sources/Scenes/*.usda`, `Sources/Assets/*` with `.picometa` sidecars,
and `UserSettings/*.{json,yaml}`; it also identifies the headless Editor build flags
(`PLUGINS.md:44-60`). The Gradle pack path reads the project and emits a `.bundle` into app assets
(`PLUGINS.md:64-80`).

Read-only host inspection on 2026-08-29 found this concrete candidate. These paths are outside the
worktree and mutable, so a future import must recompute every digest before treating it as the same
artifact:

| Layer | Evidence path | What the path establishes |
| --- | --- | --- |
| Editor source descriptor | `/Users/sushantsrikrish/AndroidStudioProjects/claimsight/editor-asset/src/main/res3d/SpatialPackContent/SpatialPackContent.spatialproject` | A 77-byte local Editor project descriptor existed; SHA-256 `cd9d7b45876665c5ec7a1771ad96088adaca5532e62223556aee31054ac99ec0`. |
| Editor-authored scene | `/Users/sushantsrikrish/AndroidStudioProjects/claimsight/editor-asset/src/main/res3d/SpatialPackContent/Sources/Scenes/MyScene.usda:1-140` | The 5,114-byte USDA declares metre units, `StageEnvironmentLightingComponent`, an IBL asset, and a referenced textured sky sphere; SHA-256 `97974961f46d00bbc8b1e87f15145175ad25bce8e7963b3b466539321706868f`. Its own metadata names `Spatial Editor V0.10.2-alpha.3` (`/Users/sushantsrikrish/AndroidStudioProjects/claimsight/editor-asset/src/main/res3d/SpatialPackContent/Sources/Scenes/MyScene.usda:3-7`). |
| Pack configuration | `/Users/sushantsrikrish/AndroidStudioProjects/claimsight/editor-asset/build.gradle:1-29` | The module applies `com.pico.spatial.tools` 0.13.1 and names output `editor-asset`. |
| Built bundle | `/Users/sushantsrikrish/AndroidStudioProjects/claimsight/editor-asset/build/spatial/bundle/editor-asset.bundle` | A 6,920,172-byte ZIP spatial bundle existed; `BundleInfo.json` and `AssetInfo.json` were present; SHA-256 `02b505ea5db1bf9f12a3044b589aed08d6789cb6e24a125b4527df45e8d74c59`. |
| App packaging | `/Users/sushantsrikrish/AndroidStudioProjects/claimsight/app/build.gradle.kts:7-19,32-60` | Source declares `com.example.claimsight`, preserves `.bundle`, and depends on `:editor-asset`. |
| Manifest route | `/Users/sushantsrikrish/AndroidStudioProjects/claimsight/app/src/main/AndroidManifest.xml:26-48` | Claimsight launches a manifest-declared Full Stage (`pico.spatial.stage.style=3`). |
| Candidate APK | `/Users/sushantsrikrish/AndroidStudioProjects/claimsight/app/build/intermediates/apk/debug/app-debug.apk` | A 45,342,968-byte APK/ZIP existed and contained `assets/editor-asset.bundle` at the same packaged size; SHA-256 `acb9362ec02c5cb5afdf8587bbcdec4b4b6e603b5ed14ee3686283ef8cd52fe3`. |

This makes Claimsight a structurally credible imported Editor-environment row. It does not prove the
APK's build invocation, installability, runtime pixels, or boundary behavior because no receipt or
looked capture is bound to those bytes.

The SDK trees also contain Editor support payloads, not user environment proofs:

- `/Users/sushantsrikrish/Library/PICO/sdk/0.13/editor/Spatial Editor.app/Contents/MacOS/Spatial Editor`
  is an 89,745,984-byte arm64 Mach-O executable, and its 8,908-byte `ide_build.sh` is a shell wrapper;
  together they are the local 0.13 Editor/build lane described by the recon
  (`PLUGINS.md:40,49-51`).
- Both `/Users/sushantsrikrish/Library/PICO/sdk/0.13/editor/Spatial Editor.app/Contents/MacOS/scene_preview/ScenePreview.apk`
  and `/Users/sushantsrikrish/Library/PICO/sdk/6.0/editor/Spatial Editor.app/Contents/MacOS/scene_preview/ScenePreview.apk`
  are byte-identical 8,350,547-byte ZIP/APKs (SHA-256
  `811f59e67330a08c8c53d6dcb9fa3bb37a961a4d8fd284e7bdc280a4a78f9442`): Editor preview-channel
  support, not authored environment apps (`PLUGINS.md:59`).
- `/Users/sushantsrikrish/Library/Application Support/Google/AndroidStudio2025.1.4/plugins/SpatialPlugin/lib/SpatialPlugin-0.13.2.jar`
  is a 26,950,604-byte ZIP/JAR and contains the `editor_project` and `full_stage` template payloads
  described in `PLUGINS.md:30-42`; it is a scaffold source, not a built test result.
- `assets/menu.bundle` is a tracked 49,227-byte ZIP spatial bundle used as a packaged app asset
  (`src/projectgen.ts:33`; `src/compiler.ts:268-298`). No Editor-source identity or build receipt is
  bound to those bytes, so authorship remains UNVERIFIED and it is excluded from the environment row.

### 2.5 Movement and settled observation already exist

The current free-camera stack has the exact primitives the experiment needs:

- Translation uses serial-qualified gRPC `sendKey` keydown/hold/keyup for W/A/S/D/Q/E. `keyHold`
  always attempts keyup, avoids replaying an uncertain keydown, and retries release only against the
  same discovery identity (`src/cameradrive.ts:187-304`).
- Rotation uses a right-button CoreGraphics drag against a serial/discovery/PID-bound qemu window
  and refuses non-macOS or ambiguous binding (`src/cameradrive.ts:56-105,138-160,307-348`).
- `capture_orbit` already consumes an ordered move array, returns action receipts, and settles before
  returning a frame (`src/cameradrive.ts:351-470`). `capture_multiview` is a second caller of the same
  action grammar and implements a pre-authored route plus inverse moves
  (`src/cameradrive.ts:475-603`).
- `capture_settled` is implemented. The pure primitive requires two consecutive byte-identical
  frames, and a timeout retains the last frame without calling it a waypoint
  (`src/observation.ts:62-120`). Its registered executor binds the requested serial/boot identity,
  persists an external hash-checked capture, and caps the receipt at structural with LOOK required
  (`src/observation.ts:351-530,579-628`).

The original MR navigation roadmap ranked `capture_settled` as Phase 1A and semantic snapshots as
Phase 1B; both are now present. Its deferred Phase 1 item 3 is the bounded target-acquisition
controller `navigate_to_scene_target` (`docs/superpowers/plans/2026-08-28-mr-agent-navigation-and-scene-understanding.md:901-918,957-970`).
The proposed boundary runner must become another controller over the shared action/settle layer, not
a competing implementation of keys, CGEvents, or captures.

### 2.6 Application continuity, lifecycle, logcat, and watchdog clues

`capture_settled` binds a runtime device, not an application. The strongest current application
binding is `query_scene_anchors`: it checks receipt identity, online serial/boot, installed APK hash,
one PID with start ticks, and the exact resumed component (`src/sceneanchors.ts:976-1072`). Native
run receipts similarly poll PID/foreground under one deadline and recheck PID/start ticks/foreground
around capture (`src/nativefleetreceipt.ts:654-828,833-889`). Those checks should be extracted or
reused rather than reimplemented with a loose `pidof` boolean.

The repository already exposes general logcat dump/filter/clear plus bounded regex assertion
(`src/adb.ts:120-147,194-240`). A build run clears logs before launch, reads PID-scoped and global
logs, and checks the PID again (`src/workflow.ts:270-314`). Logcat is structural evidence about
messages; it does not prove visible output.

The bounded read-only recon of readable 0.13 and 6.0 system-image text yielded two candidate strings:

- the system-image project name `XRGuardianServiceBin2`
  (`/Users/sushantsrikrish/Library/PICO/sdk/0.13/emulator/system-images/system-images/manifest.xml:81`;
  `/Users/sushantsrikrish/Library/PICO/sdk/6.0/emulator/system-images/system-images/manifest.xml:82`);
- the configured pathname `SDK_Boundary_ConfigFile.txt`
  (`/Users/sushantsrikrish/Library/PICO/sdk/0.13/emulator/system-images/system-images/NOTICE.txt:934`;
  `/Users/sushantsrikrish/Library/PICO/sdk/6.0/emulator/system-images/system-images/NOTICE.txt:937`).

Neither cited file identifies its string as a log tag or event contract. The first execution must
capture a bounded full logcat window and discover actual tags before narrowing a filter.

Tracked historical claims identify `SpatialRuntimeService Watchdog` lines whose `focus` names the
app and whose `lastRenderTime` advances, but those observations are emulator-scoped and do not define
a parser contract (`docs/claims/claims.json:4206-4208,4685`; `docs/claims/claims.json:5560-5562`).
For this experiment the watchdog is a candidate corroborating signal: an advancing value supports
continued rendering structurally; absence or a stalled value is `no_signal` until its semantics are
measured.

## 3. Selected architecture and rejected alternatives

Three approaches were considered:

1. **Put a fixed long route directly inside `capture_orbit`.** This is the smallest diff, but it
   would mix application continuity, log capture, recovery, and experimental outcomes into a raw
   camera tool.
2. **Implement `navigate_to_scene_target` first and disguise boundary walking as target navigation.**
   That controller needs semantic target acquisition and a guide; the boundary experiment needs a
   controlled open-loop distance/speed/direction sweep. Coupling them would delay the boundary test
   and contaminate its independent variable.
3. **Extract one route executor and place two controllers above it. Selected.** `capture_orbit`
   remains a low-level caller, the boundary runner supplies fixed routes and continuity sampling,
   and deferred navigation supplies guide-driven action selection. Action application and settled
   observation remain single-owner.

The proposed dependency shape is:

```text
serial + discovery + qemu-window binding
                  |
                  v
       executeBoundCameraActions
          | keyHold / rightDrag + release receipts
          +--------------------------> capture_orbit / capture_multiview
                  |
                  v
       executeRelativeCameraRoute
          | capture_settled waypoint
          | action + continuity receipts
          +--------------------------+
          |                          |
          v                          v
run_immersive_boundary_experiment   navigate_to_scene_target
fixed staircase + recovery          semantic guide + visual servo
```

The shared executor does not infer an absolute pose. It accepts actions, enforces per-action and
cumulative budgets, pairs release, samples continuity, calls settled capture, and returns a trace.
Controllers choose the next action and interpret their own stop conditions.

## 4. What to build: minimal immersive app matrix

### 4.1 One deterministic Boundary Lab, three generated apps

Create one AppSpec-authored Boundary Lab scene and materialize three stable brief IDs from the same
content definition. The app owns a high-contrast all-view enclosure, a distinct app sentinel, and
geometric route gates at proposed 1, 2, 4, 8, 16, and 32 metre offsets on four axes. The outer gate
defines the experiment's declared test envelope; a run that does not visibly witness it cannot claim
that its route crossed the envelope. The exact render distance and gate legibility are UNVERIFIED
until the first looked build.

The dynamic variant has two visually distinct sentinels. `MANIFEST MIXED ROOT` is authored in the
launcher `DefaultStage` and is expected to become visible after the secondary Stage closes;
`DYNAMIC FULL` surrounds the user only in the secondary Stage. The plan does not assume both render
concurrently. This makes “secondary Stage returned to the same app” distinguishable from “system
home replaced the app” in both pixels and foreground state.

| ID | App / production path | Stage route | Purpose |
| --- | --- | --- | --- |
| `M0` | Brief ID `boundarylabmixed` → `com.fleet.boundarylabmixed`; materialize the shared Boundary Lab AppSpec with `meta.stageStyle="1"`, then use existing fleet/compiler generation | Manifest `DefaultStage`, Mixed | Partner-route control. Home pixels are expected behind the app sentinel; disappearance of the sentinel, not home visibility alone, is the event. |
| `F1` | Brief ID `boundarylabmanifestfull` → `com.fleet.boundarylabmanifestfull`; same content, `meta.stageStyle="3"` | Manifest `DefaultStage`, Full | Isolates Full immersion without dynamic stage entry. Existing scaffold/project generation owns the manifest substitution (`src/compiler.ts:57-64`; `src/projectgen.ts:185-187`). |
| `F2` | Brief ID `boundarylabdynamicfull` → `com.fleet.boundarylabdynamicfull`; same content plus one generated secondary Stage and an experiment-only entry bridge | Manifest Mixed root, then direct `openStage(id, StageStyle.Full)` | Direct test of the partner-reported dynamic route. AppSpec/container lowering declares the secondary Stage; `BoundaryProbe` owns an instrumented open without an automatic lifecycle close (`src/appspec.ts:60-75`; `src/compiler.ts:321-339`; `src/containers.ts:289-320,326-334`). |
| `E1` | Hash and import `/Users/sushantsrikrish/AndroidStudioProjects/claimsight/app/build/intermediates/apk/debug/app-debug.apk`; use `verify_pico_apk` only as an import precheck, then rebuild from source only in a separately authorized provenance-strengthening step | Editor-authored payload in manifest Full app | Establishes whether an actual Editor environment exhibits the symptom. It is not a matched authoring comparison because its plugin/SDK and content differ from Boundary Lab. |

Before `E1` enters any pixel outcome, an operator must LOOK at its attributed route baseline and bind
a stable scene-specific landmark set plus capture hash. If no stable Claimsight landmark is legible,
`E1` remains an import/lifecycle row and cannot receive a retained/ejected visual outcome.

Do not substitute one of the 22 existing Full briefs for the matched matrix. They are useful
regression candidates after Phase 1, but their content, interaction, and evidence histories differ.
Boundary Lab keeps route kind as the primary changed variable.

### 4.2 Production and provenance rules

- `M0`, `F1`, and `F2` use one canonical Boundary Lab source object. A pure matrix materializer writes
  three normalized user-store brief records with the stable IDs above, hashes each effective AppSpec,
  and tests that only package, manifest route, secondary Stage, and sentinel/entry wiring differ.
  This is compatible with current `fleet_build`, which resolves user-store briefs and derives
  `com.fleet.<briefId>` (`src/briefstore.ts:30-49`; `src/fleetbuild.ts:936-995`).
- `M0`/`F1` use the current scaffold-to-manifest route. `F2` uses the current secondary Stage
  declaration but deliberately does **not** invoke its emitted `Open*OnEnter` helper: that helper
  closes on `ON_PAUSE`/`ON_DESTROY` and would confound the event under test
  (`src/containers.ts:289-320`). Instead a debug-only `BoundaryProbeState` is owned by the manifest
  root; an exact session/generation command updates observable state, root composition runs one
  idempotent direct `openStage(id, StageStyle.Full)`, and markers distinguish requested, returned,
  explicit-close, and lifecycle-teardown events. The current generator expressly permits direct
  `navigator.openStage` use (`src/containers.ts:326-334`). No app-owned close runs before the route;
  close is allowed only in the separately receipted recovery/teardown path.
- Every generated row gets a native build receipt and exact APK digest before movement. The imported
  `E1` row records the existing APK digest and source paths but remains `imported-unreceipted` until a
  clean rebuild produces its own receipt.
- `verify_pico_apk` is only an `emulator-5554` import/install/first-light precheck and its capture is
  not the E1 route baseline (`src/verifyapk.ts:11-13,18-42,146-155`). The experiment later rebinds
  exact package/PID/APK/serial and collects its own looked baseline on the selected serial.
- SDK, Spatial Tools plugin, emulator system image, and app target versions are result dimensions.
  Claimsight's source pins Spatial Tools 0.13.1
  (`/Users/sushantsrikrish/AndroidStudioProjects/claimsight/editor-asset/build.gradle:1-29`), so it
  cannot decide a 6.0 route comparison by itself.

## 5. Proposed shared interfaces and tool surface

### 5.1 Internal relative-route contract

Create a pure-controller seam; do not expose these helpers as additional MCP tools. One waypoint is
a bounded action group followed by one continuity/settle observation, not one input action:

```ts
type RelativeCameraAction =
  | { kind: "key_hold"; key: "w" | "a" | "s" | "d" | "q" | "e"; holdMs: number }
  | { kind: "look_drag"; dxPx: number; dyPx: number };

interface RouteBudgets {
  maxActions: number;
  maxWaypoints: number;
  maxHoldMsPerAction: number;
  maxDragPxPerAction: number;
  maxCumulativeHoldMs: number;
  maxCumulativeDragPx: number;
  maxDurationMs: number;
  recoveryReserveMs: number;
}

interface RuntimeBindingReceipt {
  serial: string;
  bootId: string;
  grpc: { discoveryFile: string; qemuPid: number; address: string; tokenFingerprint?: string };
  qemuWindow: { ownerPid: number; windowId: number } | null;
}

interface BoundApplicationIdentity {
  packageName: string;
  apkSha256: string;
  allowedResumedComponents: string[];
  pid: number;
  pidStartTicks: string;
}

interface ReservedArtifactSession {
  runId: string;
  absoluteRoot: string;
  ownerNonceHash: string;
}

interface RelativeRouteWaypoint {
  seq: number;
  actions: RelativeCameraAction[];
  actionReceipts: CameraActionReceipt[];
  continuityBefore: RouteContinuityObservation;
  settle: CaptureSettledReceipt;
  continuityAfter: RouteContinuityObservation;
}

type RouteContinuityCapability =
  | { kind: "required"; binding: BoundApplicationIdentity }
  | { kind: "not_requested" };

type RouteContinuityObservation =
  | { kind: "sampled"; sample: ApplicationContinuitySample }
  | { kind: "not_requested" };

interface BoundRelativeRouteInput {
  runtimeBinding: RuntimeBindingReceipt; // exact serial, boot, discovery endpoint, qemu window
  continuity: RouteContinuityCapability;
  artifactSession: ReservedArtifactSession;
  budgets: RouteBudgets;
  capture: { maxTries: number; intervalMs: number; attemptTimeoutMs: number };
}

interface RelativeRouteDependencies {
  applyRelativeAction(action: RelativeCameraAction): Promise<CameraActionReceipt>;
  sampleContinuity?: () => Promise<ApplicationContinuitySample>;
  captureSettled(path: string): Promise<CaptureSettledReceipt>;
  allocateWaypointPath(seq: number): string;
  monotonicNs(): bigint;
}

type RelativeRouteStop =
  | "controller_stop"
  | "terminal_signal_candidate"
  | "action_failed"
  | "input_release_uncertain"
  | "route_unsettled"
  | "binding_lost"
  | "budget_exhausted";

interface RelativeRouteTrace {
  status: RelativeRouteStop;
  waypoints: RelativeRouteWaypoint[];
  usage: { actions: number; waypoints: number; holdMs: number; dragPx: number; durationMs: number };
}

async function executeRelativeCameraRoute(
  input: BoundRelativeRouteInput,
  decide: (trace: readonly RelativeRouteWaypoint[]) => RelativeCameraAction[] | "stop",
  deps: RelativeRouteDependencies,
): Promise<RelativeRouteTrace>;

async function executeBoundCameraActions(
  binding: RuntimeBindingReceipt,
  actions: readonly RelativeCameraAction[],
  deps: Pick<RelativeRouteDependencies, "applyRelativeAction">,
): Promise<CameraActionReceipt[]>;
```

The implementation first extracts an internal action adapter around current `keyHold`, serial/qemu
binding, private `rightDrag`, and private `applyMoves`; it does not duplicate them
(`src/cameradrive.ts:138-160,170-348,360-408`). That adapter owns release certainty and per-action
validation. The route layer owns cumulative limits, deterministic paths under one reserved external
run directory, and the stop rule. A conservative preflight includes every hold, action timeout,
continuity probe, capture attempt/interval, log finalization, and recovery reserve; inputs whose
worst-case estimate exceeds `maxDurationMs` are rejected before movement.

Boundary and `navigate_to_scene_target` callers set continuity to `required`; omission of the sampler
then fails preflight. Any future application-neutral route caller must explicitly set
`not_requested`, receive `RouteContinuityObservation {kind:"not_requested"}`, and never invent
package/APK/PID facts.

`capture_orbit` and `capture_multiview` become compatibility adapters over the lower action core while
retaining their existing optional/final capture behavior and public schemas
(`src/cameradrive.ts:351-603`). The application-aware route executor composes that same core with
continuity and settled waypoints. `navigate_to_scene_target` later supplies a visual-servo `decide` callback matching the
already-proposed bounded controller (`docs/superpowers/plans/2026-08-28-mr-agent-navigation-and-scene-understanding.md:506-580`).

### 5.2 Application continuity sample

The proposed sample and app-event grammar are structural and timestamped:

```ts
interface BoundaryProbeEventV1 {
  schemaVersion: 1;
  sessionId: string;
  generation: number;
  seq: number;
  monotonicNs: string;
  kind: "command_received" | "stage_open_requested" | "stage_open_returned"
      | "explicit_close_requested" | "explicit_close_returned" | "lifecycle" | "focus";
  lifecycle?: "ON_CREATE" | "ON_START" | "ON_RESUME" | "ON_PAUSE" | "ON_STOP" | "ON_DESTROY";
  requestedDynamicStageStyle?: "Full";
  detail?: string;
}

interface ApplicationContinuitySample {
  observedAtMonotonicNs: string;
  serial: string;
  bootId: string;
  packageName: string;
  allowedResumedComponents: string[];
  apkSha256: string;
  pid: number | null;
  pidStartTicks: string | null;
  resumedComponents: string[];
  foreground: "exact_allowed" | "same_package_unlisted" | "different_package" | "absent" | "unknown";
  probeEventsSincePrior: BoundaryProbeEventV1[];
  probeParse: "ok" | "absent" | "malformed" | "truncated";
  probeSequence: "complete" | "gap" | "wrong_session" | "wrong_generation" | "unknown";
  watchdog: { status: "advancing" | "stalled" | "absent" | "unparsed"; focus?: string; lastRenderTime?: string };
}
```

Extract one shared pure foreground parser/classifier from the receipt path without weakening its
existing semantics; the scene-query helper currently collapses to one expected component, so it is
not enough by itself (`src/nativefleetreceipt.ts:654-828`; `src/sceneanchors.ts:976-1072`). Allowed
components come from the exact APK/manifest plus a route-specific preflight, never from accepting an
arbitrary foreground observed after movement. A continuity sample never decides the pixel outcome.
Malformed/absent/truncated/gapped probe events and a missing watchdog line stay explicit
`unknown`/`no_signal` states. An unconfounded `F2` route conclusion requires one parse-valid,
gap-free sequence for the exact session/generation spanning command receipt through the terminal
capture; absence of an explicit-close marker is meaningful only inside that complete sequence.
For `F2`, `requestedDynamicStageStyle:"Full"` is app self-report only; no current producer proves the
actually active secondary Stage style.

### 5.3 One new full-surface MCP tool with staged review

Add only `run_immersive_boundary_experiment`. Do not add a new walking tool and do not add a Phase-1
Door. A later compatible `pico_look` goal may wrap this full-surface tool after its schema and safety
are stable; the existing navigation plan already reserves a goal-oriented Door adapter
(`docs/superpowers/plans/2026-08-28-mr-agent-navigation-and-scene-understanding.md:639-665`).

Its input is a discriminated session action. Generated and imported provenance are also a closed
union, so `E1` cannot silently omit a field required by generated rows:

```ts
type ScenarioProvenance =
  | { kind: "native_run_receipt"; receiptId: string; apkSha256: string }
  | { kind: "imported_apk"; apkPath: string; apkSha256: string; inventoryObservedAt: string };

interface BoundaryScenario {
  id: string;
  packageName: string;
  launchComponent: string;
  allowedResumedComponents: string[];
  entryRoute: "manifest_mixed" | "manifest_full" | "dynamic_full" | "editor_manifest_full";
  expectedManifestStageStyle: "Mixed" | "Full";
  requestedDynamicStageStyle?: "Full"; // app self-report expectation, not active-style proof
  dynamicEntry?: {
    receiverComponent: string;
    action: string;
    stageId: string;
    requireSessionCapability: true;
    expectedAcks: ["command_received", "stage_open_requested", "stage_open_returned"];
  };
}

interface VisualFrameAttestation {
  captureSha256: string;
  visibleState: "boundarylab_mixed" | "boundarylab_manifest_full" | "boundarylab_dynamic_full"
      | "claimsight_environment" | "system_home" | "black_or_inconclusive";
  sentinels: string[];
  witnessedGateM?: 0 | 1 | 2 | 4 | 8 | 16 | 32;
  attestation: string;
}

interface BoundaryWaypointPlan {
  seq: number;
  targetGateM: 1 | 2 | 4 | 8 | 16 | 32;
  actions: readonly RelativeCameraAction[];
}

type BoundaryRouteSource =
  | { kind: "calibration_seed"; waypoints: readonly BoundaryWaypointPlan[] }
  | { kind: "replay"; calibrationRouteRef: CalibrationRouteRef };

interface CalibrationRouteRef {
  absolutePath: string;
  routeScriptSha256: string;
  sourceRunManifestSha256: string;
  sourceAdjudicationSha256: string;
}

interface BoundaryRoute {
  direction: "forward" | "backward" | "left" | "right";
  speedProfile: "slow" | "medium" | "fast" | "staircase";
  requiredTraversalM: 32;
  gateSequenceM: readonly [1, 2, 4, 8, 16, 32];
  source: BoundaryRouteSource;
  budgets: RouteBudgets;
}

interface SettledCapturePolicy {
  maxTries: number;
  intervalMs: number;
  attemptTimeoutMs: number;
  comparison: "byte_exact";
}

interface RequiredReviewItem {
  captureSha256: string;
  role: "home_reference" | "app_baseline" | "waypoint" | "transition" | "recovery";
  waypointSeq?: number;
  settled: boolean;
}

type BoundaryExperimentInput =
  | { action: "prepare"; serial: string; scenario: BoundaryScenario; provenance: ScenarioProvenance;
      artifactRoot: string; route: BoundaryRoute; capture: SettledCapturePolicy }
  | { action: "step"; runId: string; reviewedPriorFrame: VisualFrameAttestation }
  | { action: "adjudicate"; runId: string; scope: "route" | "recovery";
      frameAttestations: VisualFrameAttestation[] }
  | { action: "recover"; runId: string };
```

Proposed generated-row prepare input:

```json
{
  "action": "prepare",
  "serial": "emulator-5554",
  "scenario": {
    "id": "boundarylab-dynamic-full",
    "packageName": "com.fleet.boundarylabdynamicfull",
    "launchComponent": "com.fleet.boundarylabdynamicfull/.platform.LaunchActivity",
    "allowedResumedComponents": ["com.fleet.boundarylabdynamicfull/.platform.LaunchActivity"],
    "entryRoute": "dynamic_full",
    "expectedManifestStageStyle": "Mixed",
    "requestedDynamicStageStyle": "Full",
    "dynamicEntry": {
      "receiverComponent": "com.fleet.boundarylabdynamicfull/.agent.BoundaryProbeReceiver",
      "action": "com.fleet.boundarylabdynamicfull.BOUNDARY_PROBE",
      "stageId": "dynamic-full",
      "requireSessionCapability": true,
      "expectedAcks": ["command_received", "stage_open_requested", "stage_open_returned"]
    }
  },
  "provenance": {
    "kind": "native_run_receipt",
    "receiptId": "<64 lowercase hex>",
    "apkSha256": "<64 lowercase hex>"
  },
  "artifactRoot": "/external/session/boundary",
  "route": {
    "direction": "forward",
    "speedProfile": "staircase",
    "requiredTraversalM": 32,
    "gateSequenceM": [1, 2, 4, 8, 16, 32],
    "source": {
      "kind": "replay",
      "calibrationRouteRef": {
        "absolutePath": "/external/session/boundary/m0-calibration/route-script.json",
        "routeScriptSha256": "<64 lowercase hex>",
        "sourceRunManifestSha256": "<64 lowercase hex>",
        "sourceAdjudicationSha256": "<64 lowercase hex>"
      }
    },
    "budgets": {
      "maxActions": 64,
      "maxWaypoints": 10,
      "maxHoldMsPerAction": 5000,
      "maxDragPxPerAction": 360,
      "maxCumulativeHoldMs": 60000,
      "maxCumulativeDragPx": 1440,
      "maxDurationMs": 600000,
      "recoveryReserveMs": 90000
    }
  },
  "capture": {"maxTries": 4, "intervalMs": 500, "attemptTimeoutMs": 3000,
              "comparison": "byte_exact"}
}
```

The first `M0` run supplies `source.kind:"calibration_seed"` with every exact immutable action group;
the controller may select only the next stored group. Once a looked M0 run attests the 32 m outer
gate, route adjudication publishes the resolved groups and canonical route-script hash. Matched `F1`
and `F2` resolve an external immutable `calibrationRouteRef` into those exact groups and store the
full normalized script in their own `run.json`; no controller may synthesize or mutate movement.
Replay requires a regular non-symlink external artifact whose script, source M0 run manifest, and
route-adjudication hashes all match and whose adjudication attests the outer gate. Missing or
unverifiable references fail before movement. `E1` may replay the same inputs, but without Boundary
Lab gates it cannot inherit their metric-distance claim.

`prepare` reserves a non-existing external run directory, stores the normalized full script and hash, binds
provenance/runtime/application, captures home and app baselines, and returns
`needs_baseline_review`; it does not move. Each `step` revalidates the hash and visible-state
attestation for the prior capture, applies exactly the next pre-authored action group, samples
continuity, settles, captures, and returns `needs_waypoint_review`. A terminal/inconclusive prior
attestation, an attested 32 m gate, or a structural terminal signal prevents later movement. Thus the
agent LOOKs between steps and the tool never has to classify its own pixels.

For `F2`, `prepare` generates an unpredictable session capability and generation, launches the one
`launchComponent` with that context, and sends commands only to the exact debug receiver/action/stage
declared above. Logs retain only a capability hash. A wrong capability, session, generation, receiver,
or repeated open generation is rejected and acknowledged as such; the receiver is excluded from
release builds.

Every published capture appends one immutable `RequiredReviewItem`. Route adjudication requires
exactly one compatible attestation for home reference, app baseline, every completed settled waypoint,
and any transition capture; recovery adjudication separately requires its recovery item. Missing,
duplicate, unexpected, unsettled, or scenario-incompatible entries fail closed, preventing selective
frame submission.

`step` returns only collection status, structural candidate signals, action/settle/continuity
receipts, raw artifact hashes, and `visualReviewRequired:true`; it cannot issue
`retained_immersive`, `returned_to_app_default_stage`, or `ejected_to_system_home` from self-collected
pixels. `adjudicate` accepts only attestations bound to capture hashes already in that immutable run,
combines them with structural state, and applies Section 7's outcome table. `recover` is accepted only
after adjudication and certain input release. The existing `record_verification` remains the authority
that can record the looked capture; adjudication reports an evidence ceiling, not an automatic ledger
promotion (`src/ledger.ts:813-877`). No action returns a bare `passed:true`.

## 6. Experiment protocol

### 6.1 Preconditions and start-state binding

1. `prepare` selects exactly one serial and establishes serial → discovery endpoint → qemu-window
   binding before any CGEvent or key action. The current selector already refuses ambiguity
   (`src/cameradrive.ts:56-105,138-160`).
2. Bind the scenario's effective AppSpec, provenance union, installed APK digest, package, singular
   launch component, allowed component set, PID/start ticks, boot ID, and declared/requested stage
   route. For `F2`, prepare also binds the exact debug receiver/action/stage plus a fresh
   session-capability/generation. The component set is fixed before dynamic entry; an unlisted
   same-package component is a characterized preflight result, not silently trusted.
3. Start a bounded prepare log window before app launch/dynamic open. Capture and LOOK at a system-home
   reference, then capture the route-specific app baseline. Boundary Lab Full rows require the opaque
   enclosure and correct sentinel; Mixed requires its sentinel over home; `E1` requires a looked,
   hash-bound stable landmark set.
4. Require a settled baseline. If byte-exact settlement times out, return `route_unsettled`; the last
   frame remains diagnostic only (`src/observation.ts:35-60,113-120`). For `F2`, also require a bounded
   post-open dwell with `stage_open_requested`/`stage_open_returned`, no explicit-close event, stable
   package/PID, and the looked `DYNAMIC FULL` baseline. The app marker proves only what it requested.
5. Return `needs_baseline_review` without moving. A later `step` call must carry the exact baseline
   hash and narrow visible-state attestation. It starts a bounded step log window, recaptures the
   prior frame, and refuses movement if runtime binding changed or bytes no longer match the reviewed
   capture.

### 6.2 Scripted route and boundary-envelope witness

Each matched run begins from the still-bound prepared state or a validated reset snapshot/fixture
whose baseline sentinel/gate frame has been LOOKed and hash-bound. Current snapshot wrappers do not
wait for post-load readiness or capture a frame (`src/agentloop.ts:53-81`), so the future runner must
add readiness plus `capture_settled`; snapshot-load success alone is not a reset proof. Any reset
whose recapture differs from the reviewed baseline pauses at `needs_baseline_review` again.

The proposed staircase is:

1. Apply short key holds first, then increase hold duration without exceeding the current 50–5000 ms
   per-action bounds (`src/cameradrive.ts:351-358`).
2. Pair every keydown with keyup through `keyHold`; stop immediately on `failed` or
   `release_uncertain` (`src/cameradrive.ts:187-304`).
3. Group only the inputs required to approach one declared visual gate into a waypoint; after the
   group, call the shared settled-capture primitive and sample application continuity on both sides.
4. Return after that one waypoint. LOOK at the exact frame; call the next `step` only when the
   attestation still shows the expected app state and no 32 m gate. An attested outer gate, terminal or
   inconclusive state, structural terminal signal, or action/time budget ends movement.
5. Repeat from the reset fixture for backward, left, and right. Use a bound CGEvent look only to
   align the initial view or inspect a transition; movement remains W/S/A/D relative to the bound
   facing.

For each direction/profile, calibrate the exact seed groups on looked `M0` first. Only a calibration
that visibly reaches the 32 m gate can publish a replay receipt; `F1` and `F2` then consume its exact
canonical script/hash. A seed that exhausts its budget first closes as
`no_ejection_within_observed_budget` and cannot seed the matched comparison.

Hold time is recorded as input, not converted to metres. The visual gate sequence supplies the
proposed displacement witness. Until the gate is seen, `no_ejection_within_observed_budget` is the
strongest non-ejection statement. This resolves “long enough to cross any boundary radius at or below
32 m” as a declared, witnessed test envelope rather than an invented universal radius; radii beyond
that envelope remain untested.

### 6.3 Measured signals

| Signal axis | Collection | Positive ejection/return observation | Honest limitation |
| --- | --- | --- | --- |
| Pixels | Looked home reference and reviewed app baseline; settled frame per waypoint; immediate terminal and recovery frames | An adjudicator binds exact capture hashes to Full/root/Claimsight-landmark/home/inconclusive states | Collection assigns no visual semantics. A black adb frame is inconclusive (`README.md:140-147`). Mixed already shows home, so only sentinel loss distinguishes it. |
| System/app logs | Raw bounded `logcat -b all`; proposed versioned `BoundaryProbe` markers; offline tag/message inventory | Timestamped Stage/lifecycle/system messages correlate with the first attested changed frame | The cited SDK files establish no Guardian tag; log text is structural, not visual. |
| App lifecycle | Proposed debug `LifecycleEventObserver` markers plus host resumed-component samples | `ON_PAUSE`, `ON_STOP`, `ON_DESTROY`, focus loss, or a different resumed component occurs near the transition | Absence does not prove rendered continuity. `F2` avoids the current auto-close helper because it closes on pause (`src/containers.ts:289-320`). |
| Process/runtime | PID/start ticks, installed APK digest, foreground samples, crash/ANR scan | PID changes/dies, start ticks change, or foreground moves to system home | A process failure is `app_lifecycle_loss`, not automatically Guardian ejection. |
| Runtime watchdog | Discover and parse observed `SpatialRuntimeService Watchdog` lines; retain raw lines | Focus changes away from the app or `lastRenderTime` stops advancing at the pixel transition | Historical emulator claims only (`docs/claims/claims.json:4206-4208,4685`); missing/unparsed is `no_signal`. |
| Route execution | Per-key/drag acknowledgement, cumulative budgets, settled hashes, witnessed gate | Outcome correlates with exact action sequence/distance gate | Relative free camera has no grounded absolute pose (`src/cameradrive.ts:20-34`). |

The debug app marker tag is **PROPOSED** as `BoundaryProbe`. It emits the versioned grammar in Section
5.2: session/sequence, package/build hash, manifest style, *requested* dynamic style, stage-open call
start/return, explicit-close call start/return, lifecycle/focus event, recovery command, and route
acknowledgement. It never calls its requested style “observed” and never claims pixels were visible.

Candidate system strings are handled as hypotheses:

| Candidate | Grounding | Treatment |
| --- | --- | --- |
| `XRGuardianServiceBin2` | SDK system-image manifest project name cited in Section 2.6 | Retain raw logs and manually inventory transition-correlated lines; do not infer that this project name maps to an Android package or log tag. |
| `SDK_Boundary_ConfigFile.txt` | SDK NOTICE pathname cited in Section 2.6 | Configuration clue only; do not expect it in logcat. |
| `SpatialRuntimeService` / `Watchdog` / `lastRenderTime` | Historical tracked emulator observations in `docs/claims/claims.json:4206-4208,4685` | Candidate runtime-continuity parser with raw-line fallback. |
| `BoundaryProbe` | Proposed app-owned tag | Exact structured app lifecycle/stage markers; structural only. |

### 6.4 Time correlation and artifact set

Every action, continuity sample, and app marker carries monotonic time where available. Raw logcat
also retains wall-clock/threadtime. The run manifest records the offset sample used to correlate the
two domains; it does not pretend they are atomically sampled.

The proposed log collector owns one exact `adb -s <serial> logcat -b all -v threadtime` child per
prepare/step window. It records child PID/start time and a unique app start marker, enforces the run's
duration plus a proposed 64 MiB byte cap, streams to a temporary file under the reserved session,
then terminates only that child, awaits exit, atomically publishes, and hashes the artifact. Timeout,
forced termination, truncation, or malformed lines remain explicit collector status. Current adb
helpers only dump/filter/assert; this long-running bounded ownership is new work
(`src/adb.ts:120-147,194-240`). Unknown watchdog/system lines remain in raw evidence.

`prepare` atomically reserves a non-existing external directory with a random owner nonce and refuses
an existing path, symlink, repository-contained path, or owner mismatch. Every later action must
present the run ID/owner binding; capture allocation is deterministic and exclusive. Current settled
capture already rejects repository-contained output and hash-checks publication, which is the lower
layer to retain (`src/observation.ts:260-358,451-530`).

One external run directory contains:

```text
run.json                         normalized identities, full route script/hash, state/status
required-review.json             exact capture roles/hashes required for each adjudication scope
route-script.json                M0-only immutable replay groups + source/adjudication hashes
actions.jsonl                    action and settle receipts in sequence
continuity.jsonl                 PID/start-tick/foreground/lifecycle/watchdog samples
prepare-logcat-all.txt           bounded raw launch/open log window
step-1xx-logcat-all.txt          bounded raw per-waypoint transition windows
logcat-index.json                discovered tags/messages and correlation offsets
captures/000-home-reference.png  system-home reference
captures/010-app-baseline.png    route-specific baseline
captures/1xx-waypoint-*.png      selected settled waypoints
captures/950-recovery.png        post-recovery frame
adjudication.json                hash-bound attestations, terminal-frame ref, derived outcome
```

All capture records include absolute path, SHA-256, size, dimensions, serial, and timestamp, matching
the existing proposed/current capture-reference discipline
(`src/observation.ts:128-163`; `docs/superpowers/plans/2026-08-28-mr-agent-navigation-and-scene-understanding.md:323-343`).
Room frames and logs stay outside the repository.

## 7. Outcome rules and evidence ceilings

`step` can stop structurally on a candidate transition, but it returns `needs_waypoint_review`, not a
row below. Only the later `adjudicate` action applies
this table after exact capture hashes have been LOOKed and attested. Its ceiling says what the run can
earn; `record_verification` must still record any `vision_verified` or `device_verified` entry.

| Outcome | Required observations | Run verdict | Maximum emulator evidence | Maximum Swan evidence |
| --- | --- | --- | --- | --- |
| `retained_immersive_through_route` | Required outer gate attested; expected Boundary Lab sentinel or E1 landmark set present in every required looked frame; package/PID/start ticks and route binding remain coherent; no crash | PASS for this exact scenario/route only | Structural bindings/actions; exact looked frames are eligible for `vision_verified` | Same visual ceiling unless current `device_verified` live identity and same-serial byte-equal recapture all pass (`docs/DEVICE_VERIFICATION.md:14-38`) |
| `returned_to_app_default_stage` | Dynamic Full sentinel disappears; distinct Mixed-root sentinel is attested; same package/PID remains resumed; complete gap-free F2 probe sequence has no app-owned explicit-close marker before the first changed frame | FAIL for dynamic-Full retention; characterized as same-app return | Structural correlation; looked transition pixels are eligible for `vision_verified` | Eligible for `device_verified` only through the unchanged device protocol |
| `ejected_to_system_home` | App sentinel/landmarks disappear; terminal pixels are attested as captured home; foreground/lifecycle is reported; for F2, a complete gap-free probe sequence has no app-owned explicit close before transition | FAIL for immersive retention | Structural correlation; looked home reappearance is eligible for `vision_verified` | A `deviceOutcome:"fail"` is honest hardware evidence only when every device gate passes (`docs/DEVICE_VERIFICATION.md:14-47`) |
| `stage_self_closed_or_lifecycle_teardown` | An F2 app-owned explicit close precedes the changed frame, or probe parse/session/generation/sequence/frame ordering cannot rule it out | CHARACTERIZE; no boundary-route conclusion. Preserve `visualTransition` separately. | Structural/lifecycle; separately looked pixels retain their own eligibility | Same |
| `app_lifecycle_loss` | PID/start ticks change, process dies, crash/ANR appears, or app cannot be attributed | Operational FAIL; boundary cause unassigned | Structural/logcat; any visible frame judged separately | Structural until a valid device image record is made |
| `no_ejection_within_observed_budget` | No terminal event, but outer gate not witnessed | CHARACTERIZE, never PASS | Structural route budget; looked frames can separately earn vision | Same |
| `input_release_uncertain` | A keyup cannot be acknowledged against the same runtime identity | Operational FAIL; no automated recovery or later movement | Structural only | Not applicable to wearer-guided hardware |
| `capture_inconclusive` / `route_unsettled` / `binding_lost` | Capture, settle, or identity precondition fails | CHARACTERIZE / retry after named fix | Structural only | Structural only |

`auto_judged` is not available for ejection in Phase 1. A future producer may earn it only after a
calibrated classifier distinguishes app Full, app Mixed root, system home, and black/inconclusive
frames from immutable bytes. The current eye's passthrough rules deliberately prevent generic
count/not-black checks from proving Mixed content (`src/eye.ts:212-277`).

`device_verified` is never inferred from “ran on hardware.” It requires a looked artifact, live
PICO-shaped non-emulator lineage, explicit feature/outcome, and a fresh same-serial capture whose
bytes equal the looked artifact (`src/ledger.ts:813-877`). A changing home frame may prevent that
upgrade; the honest result then remains `vision_verified` plus structural hardware lineage.

## 8. Boundary characterization and recovery

### 8.1 Factor sweep without a combinatorial first wave

Run matched `M0`/`F1`/`F2` cells before interpreting `E1`:

1. **Distance/direction staircase:** medium pulse profile in forward/back/left/right, resetting to the
   same bound start fixture between legs; record the last witnessed gate and first terminal action.
2. **Speed neighborhood:** only for routes/directions that eject or approach the terminal gate,
   repeat with slow, medium, and fast pulse profiles while holding total witnessed gate constant.
3. **Repeatability:** run each decisive cell three times from the same fixture and preserve all
   failures. Report the vector (`3/3`, `2/3`, and so on), not “always.”
4. **Editor row:** after its baseline landmark review gate, run `E1` with the same action budgets, but
   report SDK/plugin/content differences as confounds. It can show that an Editor-authored environment
   exhibits a symptom; it cannot isolate authoring route against Boundary Lab.

The dynamic-vs-manifest hypothesis is **supported for this emulator/configuration** only when matched
`F2` repeatedly reaches an adjudicated `returned_to_app_default_stage` or
`ejected_to_system_home`, with a complete gap-free probe sequence, no preceding app-owned close, and
coherent provenance/runtime binding,
while matched `F1` and `M0` retain through the same attested gates. A self-close/lifecycle-teardown
result cannot support the route hypothesis. Similar adjudicated outcomes across `F1` and `F2` weigh
against it. Mixed results, unmatched gates, or pending visual review are inconclusive. No emulator
pattern establishes hardware Guardian behavior.

### 8.2 Recovery protocol

On the first terminal signal, the runner attempts release, stops the route, snapshots the next settled
frame/log/continuity state, and then performs exactly one ordered recovery protocol. If release is
`input_release_uncertain`, it records the state and performs no automated recovery or further input:

1. **Observe without intervention** for a bounded interval. Record `auto_resumed` only if the expected
   sentinel and exact foreground return.
2. For `F2`, if the manifest Mixed root remains alive, send one session/generation-bound app command
   that changes root-owned state and directly reopens the same secondary Full Stage. Record
   `stage_reopened` only after the Full sentinel is LOOKed and application binding remains unchanged.
3. Send one normal activity launch to an allowed exact component on the already-bound serial, without
   force-stop. Record whether it was accepted, ignored, or blocked and whether the same PID/start ticks
   survived.
4. If still unrecovered, call one injected exact-serial operation that force-stops only the bound
   package, waits under a deadline, starts one allowed exact component, and rebinds PID/start ticks.
   It does not reinstall or call `verify_pico_apk`, whose serial is hardcoded
   (`src/verifyapk.ts:11-13`). Report `force_stop_relaunch` or `unrecovered`.

Recovery success does not erase the ejection outcome. Each step has its own before/after capture and
structural receipt. A later characterization wave may add a separate product-helper row to measure
the current auto-close-on-pause behavior, but that row cannot replace the unconfounded direct-open
`F2` comparison (`src/containers.ts:289-320`).

## 9. Hardware relevance: keep the axis explicit

| Finding / primitive | Emulator relevance | Swan relevance |
| --- | --- | --- |
| Manifest `stage.style` versus dynamic `openStage(StageStyle.Full)` | Directly testable and the target of the partner report | Same app-level declaration distinction is relevant, but transfer remains UNVERIFIED until a real-device run. |
| gRPC W/A/S/D/Q/E and qemu CGEvent look | Emulator-only movement backend (`src/cameradrive.ts:20-34,307-348`) | Does not transfer; a consenting wearer supplies head/body movement. |
| Serial, package, APK, PID/start-tick, foreground, lifecycle, and raw-log trace schema | Useful on emulator | Candidate shared schema through explicit serial; existing docs say adb/logcat accept serial but have no Swan run (`docs/DEVICE_VERIFICATION.md:143-160`). |
| Byte-exact `capture_settled` | Current implementation supports emulator static frames | Explicitly refused/unverified for non-emulator dynamic frames (`test/observation.mjs:247-265`). Hardware needs a measured settle policy. |
| System-home pixels | PICO emulator home reference | Device home/Guardian appearance may differ; capture/casting behavior is UNVERIFIED (`docs/DEVICE_VERIFICATION.md:68-77`). |
| `XRGuardianServiceBin2` / boundary config clues | Present in emulator system-image metadata, not proven runtime tags | May differ by build; do not transfer a tag assumption. |
| Snapshot reset | Useful only after readiness + looked baseline validation | Emulator-only; hardware needs app-owned reset and wearer return-to-mark instructions (`docs/DEVICE_VERIFICATION.md:159`). |
| Claimsight Editor APK | Structurally credible import candidate with manifest Full source | Install/runtime compatibility, Guardian behavior, and pixels are UNVERIFIED. |

This plan adds no hardware tool. H1 depends on the prior plan's **proposed**, not implemented,
`device_observation_session` surface using its `pico_device_guided` capability profile
(`docs/superpowers/plans/2026-08-28-mr-agent-navigation-and-scene-understanding.md:309-321,667-680`).
It deploys one exact build, asks a consenting wearer to follow a physically safe marked route,
collects app/system/lifecycle observations, and stops at the real Guardian. The agent never issues a
command that purports to move the wearer. A device result is scoped to the room, Guardian
configuration, OS/build, app bytes, route, and capture method.

## 10. Ranked roadmap by value and effort

Effort is a design estimate, not repository evidence. Days mean focused engineer-days and exclude
vendor response time, app-build first-run setup, emulator scheduling, and hardware access.

| Rank | Phase | Value | Effort | Buildable outcome | Honest maximum evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | **1A — shared route + continuity substrate** | Very high | **M, 4–6 days** | `executeRelativeCameraRoute`; action adapter; `capture_orbit` compatibility; continuity sampler; bounded raw-log/artifact sessions | structural; returned frames require separate LOOK |
| 2 | **1B — matched immersive app matrix** | Very high | **M, 4–6 days** | Stable `M0/F1/F2` materializations, variant hashes/build receipts, direct-open debug sentinels/events, imported Claimsight `E1` inventory | structural build/import provenance; looked baselines may separately earn vision |
| 3 | **1C — first boundary experiment** | Critical | **L, 6–9 days** | staged `run_immersive_boundary_experiment`; one reviewed forward staircase per row; exact terminal/recovery evidence bundle | structural collection plus vision eligibility only after looked-frame adjudication/recording |
| 4 | **2 — characterization + recovery matrix** | High | **L, 7–10 days** | direction/distance staircase, targeted speed sweep, three-run decisive cells, recovery taxonomy, hypothesis report | per-run evidence only; correlation remains configuration-scoped |
| 5 | **3 — deferred navigation item 3** | High | **L, 7–10 days** | two-color guide and `navigate_to_scene_target` controller consuming the Phase-1 shared executor | structural actions; looked guide/scene pixels may earn vision |
| 6 | **H1 — controlled Swan boundary run** | Critical after safety/privacy/access | **M/L, 5–8 days** | wearer-guided manifest/dynamic comparison, device logs/lifecycle/captures, recovery notes | `device_verified` only if all current identity/pixel gates pass |
| 7 | **4 — regression and product hardening** | Critical later | **XL, 2–4 weeks** | scenario manifests, app reset, privacy/retention, version matrix, calibrated pixel classifier, perf/storage budgets | scenario-dependent; never globally promoted |

The top three Phase-1 items are the first three rows: shared route/continuity (**4–6 days**), matched
apps (**4–6 days**), and the first experiment (**6–9 days**). The route substrate lands first so both
boundary work and deferred navigation consume the same tested movement semantics.

## 11. Future implementation tasks

No task below is authorized in this design wave.

### Task 1: Extract the shared relative-route executor

**Files:**

- Create: `src/navigation.ts`
- Create: `test/navigation.mjs`
- Modify: `src/cameradrive.ts`
- Modify: `package.json` and `.github/workflows/gates.yml` only if a new `test:navigation` script is
  added; otherwise attach the test to an existing explicit gate and document that ownership.

**Interfaces:**

- Consumes: `keyHold`, serial/qemu-window binding, extracted CGEvent/action adapter, and
  `executeCaptureSettled`.
- Produces: `executeBoundCameraActions`, `executeRelativeCameraRoute`, `RelativeCameraAction`, `RelativeRouteWaypoint`, and
  `RelativeRouteTrace` with the signatures in Section 5.1.

- [ ] **Step 1: Write failing pure tests** for grouped-waypoint/action order, per-action and cumulative
  caps, waypoint cap, conservative duration preflight, early stop, paired release uncertainty, settle
  timeout, continuity failure, deterministic capture allocation, and dependency injection. Assert no
  later action or recovery runs after an unsettled or release-uncertain waypoint.
- [ ] **Step 2: Build before running tests** because repository tests import `dist/`:
  `npm run build && node --test test/navigation.mjs`. Confirm failure is the missing export/behavior,
  not stale output.
- [ ] **Step 3: Extract one internal action adapter around current binding/key/drag/apply logic**, then
  implement the minimal executor. Export only internal functions required by the two controllers;
  preserve current `capture_orbit` input/output fields.
- [ ] **Step 4: Refactor `capture_orbit` and `capture_multiview` onto the action core**, not the
  application-aware wrapper. Preserve `capture_orbit {capture:false}`, final-settle behavior, public
  schemas, and fail-closed macOS/serial behavior.
- [ ] **Step 5: Rebuild and run** `node --test test/navigation.mjs test/observation.mjs`, then the
  camera/doors gates that cover registered schemas.
- [ ] **Step 6: Commit** `feat(navigation): share bounded relative camera routes`.

### Task 2: Add application continuity and bounded log collection

**Files:**

- Create: `src/runtimecontinuity.ts`
- Create: `test/runtimecontinuity.mjs`
- Modify: `src/nativefleetreceipt.ts` and/or `src/sceneanchors.ts` only to export shared pure parsers;
  do not copy their foreground/PID logic.
- Modify: `src/navigation.ts`

**Interfaces:**

- Consumes: exact package/component/APK/serial/boot expectations plus injected adb/log readers.
- Produces: `sampleApplicationContinuity()`, `parseBoundaryProbeEventV1()`, and a bounded owned
  `collectLogWindow()` returning the Section 5.2 schema plus raw external artifact references.

- [ ] **Step 1: Write fixtures** for exact foreground, OS 6 co-resumed shell, pre-allowed and unlisted
  same-package components, PID restart, missing process, boot change, every BoundaryProbe V1 event,
  absent/malformed/truncated markers, sequence gaps, wrong session/generation, advancing/stalled/
  absent/unparsed watchdog, log byte/time cap, graceful child exit, forced child termination, and
  raw-log truncation.
- [ ] **Step 2: Build and run the focused test**, confirming it fails before implementation.
- [ ] **Step 3: Extract shared parsers** without weakening the native receipt or scene-anchor
  invariants. Add exact-child log ownership and atomic hash publication; keep full raw lines when any
  parser does not match.
- [ ] **Step 4: Bind samples before and after every completed waypoint/action group** and return a
  typed stop reason on package/runtime identity loss. Per-action sampling is diagnostic-only and must
  carry its own stricter timing budget.
- [ ] **Step 5: Run** the new tests plus `test/nativefleetreceipt.mjs`, `test/sceneanchors.mjs`, and
  `test/observation.mjs` after a fresh build.
- [ ] **Step 6: Commit** `feat(observation): trace application continuity during routes`.

### Task 3: Generate the matched Boundary Lab apps

**Files:**

- Create: `briefs/boundarylabmixed.json` as canonical content.
- Create: `src/boundarymatrix.ts` and `scripts/materialize-boundary-matrix.mjs`.
- Create: `src/boundaryprobe.ts`
- Create: `test/boundaryprobe.mjs`
- Modify: `src/appspec.ts`, `src/assemble.ts`, `src/compiler.ts`, and `test/spatialbench.mjs`
- Modify: generated Agent Bridge/App wiring only through their source generators, never by committing
  generated project output.

**Interfaces:**

- Consumes: one canonical Boundary Lab AppSpec and a discriminated
  `variant: "manifest_mixed" | "manifest_full" | "dynamic_full"`.
- Produces: normalized user-store brief IDs `boundarylabmixed`, `boundarylabmanifestfull`, and
  `boundarylabdynamicfull`; exact `com.fleet.<briefId>` identity; debug-only BoundaryProbe Kotlin; and
  the existing compiler ledger. It introduces no new public MCP tool.

- [ ] **Step 1: Write schema/materialization tests** proving stable brief/package IDs, identical scene
  payload across variants, an explicit difference allowlist, one secondary Full Stage only in `F2`,
  exact effective-spec hashes, and strict rejection of contradictory route/style inputs.
- [ ] **Step 2: Write codegen tests** for distinct Mixed-root/Full sentinels, proposed route gates,
  versioned/idempotent session commands, root-owned observable state, direct stage-open call/return,
  explicit-close-only recovery, lifecycle/focus events, and debug/release exclusion. Assert the `F2`
  experiment path has no automatic `ON_PAUSE` close and rejects wrong capability, session,
  generation, receiver target, or repeat generation.
- [ ] **Step 3: Build and confirm the tests fail**, then add the minimal AppSpec field and generator.
- [ ] **Step 4: Route `F2` declarations through existing `generate_container_app_kotlin` lowering**;
  have root composition observe BoundaryProbe state and make one instrumented direct
  `navigator.openStage(..., StageStyle.Full)` call. Do not call the auto-close helper or invent a
  second container registry.
- [ ] **Step 5: Run conformance, SpatialBench, archetype, project generation, and adoption-safety
  gates** after a fresh build.
- [ ] **Step 6: In the separately authorized emulator wave, materialize then build the three stable
  IDs through existing `fleet_build`**, retain all receipt/APK/spec hashes, and LOOK at each baseline
  capture.
- [ ] **Step 7: Commit** `feat(boundary): add matched immersive probe apps` before any run evidence is
  recorded in a separate evidence commit.

### Task 4: Add the boundary experiment orchestrator

**Files:**

- Create: `src/boundaryexperiment.ts`
- Create: `test/boundaryexperiment.mjs`
- Modify: `src/index.ts`
- Modify: `package.json`, `.github/workflows/gates.yml`, and
  `test/distribution-adoption.mjs` together if registering a new test script/tool count.

**Interfaces:**

- Consumes: `executeRelativeCameraRoute`, continuity/log collector, effective scenario identity,
  reset readiness adapter, capture references, and injected recovery operations.
- Produces: the staged `run_immersive_boundary_experiment` prepare/step/adjudicate/recover schema and
  discriminated receipts from Sections 5.3 and 7.

- [ ] **Step 1: Write pure state/outcome tests** proving prepare cannot move, step cannot emit a visual
  verdict, a second step requires review of the exact prior capture, and adjudication rejects
  unknown/mismatched capture hashes. Require complete required-review manifests and reject missing,
  duplicate, unexpected, unsettled, or scenario-incompatible attestations. Cover Full retained, dynamic
  return-to-root, system-home ejection, app-owned close, process death, insufficient gate,
  incomplete/gapped/wrong-session probe streams, black/inconclusive capture, unsettled waypoint,
  binding loss, release uncertainty, and every recovery result. Pixel semantics enter only as
  hash-bound reviewed fixture attestations.
- [ ] **Step 2: Write route tests** proving the next step is refused after an attested outer gate,
  terminal/inconclusive review, uncertain release, continuity loss, action cap, waypoint cap, hold cap,
  drag cap, or time cap. Require non-empty immutable action groups, canonical route hash, exact replay
  resolution, source manifest/adjudication hash verification, missing/symlink/tampered reference
  refusal, and prohibit controller-synthesized movement. Prove boundary/navigation reject continuity
  `not_requested`; raw camera compatibility is covered against the lower action core in Task 1.
- [ ] **Step 3: Build and observe the expected failures**, then implement the smallest orchestrator.
- [ ] **Step 4: Register only the full-surface tool** and test all four action schemas plus unchanged
  Doors count.
- [ ] **Step 5: Prove artifact safety**: exclusive owner-bound external run reservation, symlink and
  repository rejection, bounded log/action/capture counts, exact-child shutdown, atomic publication,
  hashes, no tokens, and no room data in the repository.
- [ ] **Step 6: Run build, focused tests, doors, docsmeta, adoption-safety, and distribution-adoption.**
- [ ] **Step 7: Commit** `feat(boundary): run receipt-bound immersive walk experiments`.

### Task 5: Execute the first emulator matrix and recovery sequence

**Files:** External evidence directory only plus a later intentionally reviewed evidence/index update;
do not write captures or raw room logs into the repository.

- [ ] **Step 1: Acquire emulator ownership** from the coordinating wave; run doctor and follow its
  named fixes.
- [ ] **Step 2: Call `prepare` per row and LOOK at home/app baselines.** Bind the exact Boundary Lab
  sentinel or an E1 landmark set; reject any unsettled, changed, or illegible baseline.
- [ ] **Step 3: Establish one reset fixture** and validate post-load readiness plus byte-equal reviewed
  baseline rather than trusting snapshot-load success. Calibrate the forward seed on `M0`; require a
  looked 32 m gate before publishing its canonical replay receipt.
- [ ] **Step 4: Repeatedly call `step`, LOOK at its exact waypoint, and submit that hash-bound review
  before any next step**; replay the exact M0 script for `F1`, `F2`, then eligible imported `E1`.
  Preserve every failure and inconclusive bundle; stop on outer gate, terminal/inconclusive review,
  or structural stop. E1 shares input actions, not the Boundary Lab metric witness.
- [ ] **Step 5: Call `adjudicate` with all exact hash-bound visible facts** to derive the route outcome.
- [ ] **Step 6: For each adjudicated terminal row, call `recover` once**, preserve its before/after
  receipts, and LOOK at the recovery capture.
- [ ] **Step 7: Use existing `record_verification` for claims actually earned, then publish a
  configuration-scoped report** with SDK/emulator/app hashes, outcomes, raw evidence paths, and the
  remaining UNVERIFIED items. Use `visual_judge` only when a vision-capable reviewer is unavailable
  and retain the weaker evidence class.
- [ ] **Step 8: Commit only reviewed metadata/index changes**, never raw room captures/logs.

### Task 6: Characterize distance, speed, direction, and route correlation

**Files:** Extend `test/boundaryexperiment.mjs` for report aggregation; external run manifests and
reports for actual observations.

- [ ] **Step 1: Add aggregation tests** that preserve every run, distinguish unmatched traversal
  witnesses, and never promote `2/3` to “always.”
- [ ] **Step 2: Calibrate each direction staircase on `M0`, then replay its exact script for matched
  `F1/F2`**, resetting and revalidating the start fixture before each leg.
- [ ] **Step 3: Run slow/medium/fast profiles only around decisive distance cells**, then repeat each
  decisive cell three times.
- [ ] **Step 4: Add `E1` as a confounded authoring/SDK row**, not as a causal comparator.
- [ ] **Step 5: Report supported, weighed-against, or inconclusive dynamic-route correlation** using
  the Section 8.1 rule and exact run vectors.
- [ ] **Step 6: Commit** only the bounded result index/report after every cited capture has been
  reviewed and evidence class checked.

### Task 7: Reuse the executor for deferred `navigate_to_scene_target`

**Files:** `src/navigation.ts`, debug guide generator, `src/eye.ts`, Door adapter, and focused
image/action fixtures, as already scoped by
`docs/superpowers/plans/2026-08-28-mr-agent-navigation-and-scene-understanding.md:957-970`.

- [ ] **Step 1: Keep `executeRelativeCameraRoute` unchanged** and implement only the semantic-guide
  `decide` controller.
- [ ] **Step 2: Reuse the exact action, continuity, settle, budget, and trace types** from boundary
  Phase 1; prohibit a second key/CGEvent/capture implementation in review.
- [ ] **Step 3: Preserve navigation's narrower claims** (`target_visible`, `target_centered`, and
  optional `free_camera_approached`) and never rename a boundary traversal `arrived`.
- [ ] **Step 4: Run boundary route fixtures alongside navigation fixtures** so changes to shared
  motion semantics cannot regress one consumer silently.
- [ ] **Step 5: Commit** `feat(navigation): add target controller over shared routes`.

### Task 8: Run the first controlled Swan comparison

**Files:** External consent/session/evidence records plus a reviewed hardware report; no raw room
data in the repository.

- [ ] **Step 1: Approve safety, consent, local retention/deletion, room route, observer stop signal,
  and Guardian configuration before attaching hardware.**
- [ ] **Step 2: Deploy exact manifest/dynamic app bytes through the hardware-capable path**, not
  `verify_pico_apk`, which currently hardcodes the emulator (`docs/DEVICE_VERIFICATION.md:157`).
- [ ] **Step 3: Implement/gate the prior plan's proposed `device_observation_session` with its
  `pico_device_guided` capability profile before use**; the wearer moves, while the agent only
  prompts, observes, captures, and records
  (`docs/superpowers/plans/2026-08-28-mr-agent-navigation-and-scene-understanding.md:667-744`).
- [ ] **Step 4: Preserve Guardian/system/app logs, lifecycle, pixels, and recovery as separate axes.**
- [ ] **Step 5: Attempt `device_verified` only for a stable exact frame** that passes live identity and
  same-serial recapture; otherwise retain structural + vision evidence honestly.
- [ ] **Step 6: Report emulator-only, shared-app, and Swan-only findings in separate columns.**

## 12. Design-wave gates and commit boundary

Before committing this document, run exactly:

```bash
npm run build
npm run test:docsmeta
npm run test:adoption-safety
npm run test:distribution-adoption
```

Tests import `dist/`, so the build must precede every gate run. The requested acceptance accounting
for this design wave is build success, docsmeta **0 failures**, adoption-safety **48 passed / 0
failed**, and distribution-adoption **41 passed / 2 failed**. The two distribution failures are an
acknowledged baseline, not permission to add a third; retain their exact names/output in the handoff.

Stage only
`docs/superpowers/plans/2026-08-29-immersive-boundary-and-navigation.md`, verify the staged diff has
one file, commit on `immersive-boundary-design-2026-08-29`, and push only that branch. Never push or
update `main`.

## 13. UNVERIFIED register

| ID | UNVERIFIED item | Why it remains open | Closing observation | Blocks |
| --- | --- | --- | --- | --- |
| U1 | Current machine reproduces ejection at all | README explicitly says the Editor-world comparison was not replicated here (`README.md:175-179`) | Matched looked `F2` terminal run with full structural trace | Any local symptom claim |
| U2 | Dynamic entry, rather than Full style/content/version, causes the behavior | Current evidence is a partner report without a retained run (`README.md:172-180`) | Repeated adjudicated `M0/F1/F2` runs reaching equal gates with no app-owned close | Route-correlation conclusion |
| U3 | PICO's hardware fix status and Swan behavior | Repository calls the issue partner-stated/fix-in-progress and unmeasured (`README.md:172-179`) | Controlled current-build Swan comparison | Hardware conclusion |
| U4 | Emulator movement milliseconds map to metres | Current source documents relative movement and inertia, not calibrated displacement (`src/cameradrive.ts:20-34`) | Looked route-gate calibration per direction/speed | Metric boundary radius |
| U5 | The proposed 32 m visual gate is legible and rendered from every required route | Boundary Lab and its thresholds are future contracts in Section 4 | Looked baseline/waypoint captures | `retained_immersive_through_route` |
| U6 | Exact Guardian/ejection log tags and messages | Cited SDK files expose a project/config pathname, not tags (`/Users/sushantsrikrish/Library/PICO/sdk/6.0/emulator/system-images/system-images/manifest.xml:82`; `/Users/sushantsrikrish/Library/PICO/sdk/6.0/emulator/system-images/system-images/NOTICE.txt:937`) | Raw `logcat -b all` transition capture plus offline tag inventory | Narrow log filter/root-cause wording |
| U7 | Ejection triggers `ON_PAUSE`, focus loss, Stage close, process loss, or none | No local run exists | Timestamp-correlated BoundaryProbe + dumpsys/PID trace | Lifecycle characterization |
| U8 | `SpatialRuntimeService Watchdog` appears and its fields mean the same thing in this run | Only historical emulator claims ground it (`docs/claims/claims.json:4206-4208,4685`) | Raw-line capture and controlled advancing/stalled observations | Watchdog corroboration |
| U9 | adb or host-window pixels faithfully expose the ejection transition | Black immersive adb captures are inconclusive (`README.md:140-147`) | Same-moment alternate captures plus LOOK | Pixel outcome if adb is black |
| U10a | Claimsight APK build provenance | Existing source/bundle/APK are structurally aligned but lack a bound build receipt | Clean rebuild that records exact APK digest and receipt | Strong Editor-build provenance |
| U10b | Claimsight installability and visible environment | No attributed install/run receipt or looked stable landmark baseline exists | Imported-APK precheck, package/PID attribution, and looked landmark baseline | E1 runtime/pixel outcome |
| U11 | Direct dynamic Full generated by the proposed BoundaryProbe path exhibits the partner route | Current compiler labels secondary Stage opening unmeasured (`src/compiler.ts:321-339`) | `F2` build/open baseline and full trace | Dynamic row |
| U12 | App auto-resumes or requires stage reopen/activity relaunch/force-stop after ejection | No recovery measurement exists | Ordered recovery protocol with separate frames/receipts | Recovery guidance |
| U13 | Byte-exact settling is usable on hardware/live passthrough | Current implementation refuses non-emulator comparison (`test/observation.mjs:247-265`) | Measured hardware settle policy | Automated Swan waypoints |
| U14 | Emulator direction/speed correlation transfers to real Guardian distance | Free camera is emulator-only (`docs/DEVICE_VERIFICATION.md:159`) | Wearer-guided Swan route under recorded Guardian configuration | Cross-platform generalization |
| U15 | A system-home classifier can safely earn `auto_judged` | Current MR eye rejects generic count/black confidence (`src/eye.ts:212-277`) | Producer-owned immutable fixtures, calibration, false-positive/negative gates | Automated pixel verdict |
| U16 | Same-view/time correlation between action, logs, lifecycle, watchdog, and capture is atomic | Current tools sample independently | Versioned trace with measured clock offset/skew bounds | Sub-frame causal ordering |
| U17 | Claimsight's Spatial Tools plugin 0.13.1 / `spatialToolsVersion=0.13` row is compatible with the selected 6.0 emulator and comparable to 6.0 generated rows | Toolchain version is a confound, while scene metadata names Spatial Editor V0.10.2-alpha.3 and no historical build receipt binds the bytes (`/Users/sushantsrikrish/AndroidStudioProjects/claimsight/editor-asset/build.gradle:1-29`; `/Users/sushantsrikrish/AndroidStudioProjects/claimsight/editor-asset/src/main/res3d/SpatialPackContent/Sources/Scenes/MyScene.usda:3-7`) | Version-qualified import run, then optional receipt-bound 6.0 Editor rebuild | Cross-authoring comparison |
| U18 | `F2` actually runs a Full secondary Stage after requesting it | Current observed-style paths derive launcher/manifest state, not dynamic active-stage state (`src/sceneanchors.ts:976-1072`) | Looked dynamic sentinel/enclosure plus self-reported request and coherent continuity trace | Active-stage wording |
| U19 | The manifest launch component remains the exact resumed component during dynamic Stage takeover | No current dynamic-Full continuity trace exists; fleet receipts bind the launcher component (`src/fleetbuild.ts:1204-1213`) | Pre-route component inventory and repeated before/after samples | F2 binding policy |

Closing one row never closes a broader row implicitly. Every report republishes the remaining
register with exact evidence paths and the configuration scope of newly answered items.
