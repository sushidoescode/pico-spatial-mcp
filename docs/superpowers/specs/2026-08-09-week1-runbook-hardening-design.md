# Week-1 Runbook Hardening Design

**Date:** 2026-08-09

**Status:** Approved in conversation on 2026-08-09; written-spec review pending

**Scope:** The five reproduced runbook bugs and five earned improvements from the 2026-08-09 headless-Claude Week-1 validation.

## Outcome

This wave makes the runbook's agentic lane match the behavior measured on the live PICO 0.13 emulator. It fixes the structured AppSpec boundary, keeps baker cache files out of application assets, aligns raw-model tool parameters, replaces the known-broken guest video path with a proven host-window lane, and closes the local harness timeout/environment gaps. It then records the live Meshy result honestly, calibrates semantic camera movement, preserves the measured `setXrOptions` refutation, adds a real host-pointer pill-click path, and makes the proven portable agent rules opt-in during scaffolding.

The generated app BOM remains exactly PICO SDK `0.13.3`. PICO tool-payload discovery defaults to the installed `0.13` family instead of silently selecting `6.0`; explicit future-version requests remain possible. macOS-only implementations sit behind host interfaces with honest Windows-unavailable responses, because Windows remains the programme's P0 platform gap.

No code or assets in `~/pico-week1-gallery`, `~/museum-viewer`, or `~/Materials for Alex` are changed. Those projects are read-only evidence sources.

## Measured baseline

Bugs 1-4 were reproduced through the built stdio server before this design was approved. Bug 5 was audited against the 9 August harness behavior and current local files; that audit established which requested protections were already present and which sibling harnesses still lacked them.

1. A direct SDK client can pass object-valued AppSpecs through planning and compilation, but headless Claude passes both `draftSpec` and `spec` as strings. `z.any()` currently advertises only a description in MCP JSON Schema, so the schema-guided host has no object shape to follow. The downstream AppSpec validator correctly rejects the string.
2. PICO `spatialbundle pack` writes `BundleCache` beside its `-o` destination. Direct bake and catalog import therefore place `BundleCache/cache.bundle` and `cache.json` inside the caller's assets directory.
3. `measure_model({modelPath})` accepts a GLB, while `structural_asset_gate({modelPath})` fails MCP input validation because it requires `assetPath`. The same gate succeeds when the identical path is renamed to `assetPath`.
4. On emulator fingerprint `Pico/swan_oversea/pico_spaceos_oversea_emulator_arm64:16/BQ2A.260122.002-BP2A.250705.008/3803:user/test-keys`, both `adb screenrecord` and `pico-cli capture record` fail to produce a video. Logcat reports `SurfaceFlinger: Fail to record Display` and `ScreenRecord: Failed to create a mirror for screenrecord`; the guest file is zero bytes.
5. `.dev/mcp-call.mjs` already forwards the full environment and supports a per-step call timeout. `.dev/call-tool-long.mjs` already has both protections. `.dev/call-tool.mjs` forwards the environment but lacks a call timeout. `.dev/run-battery.mjs` inherits the environment but has a fixed process timeout rather than a configurable one. All `.dev` files are intentionally ignored and excluded from the npm package.

Additional measured facts shape the polish work:

- Meshy's adapter completed preview then refine on 2026-08-09 and delivered a 24,488,792-byte GLB in about 3.5 minutes. The jade measured centre-origin with `baseLift` equal to roughly half its height. [Meshy's API](https://docs.meshy.ai/en/api/text-to-3d) applies `origin_at` only when `auto_size` is enabled; the current request omits `auto_size`.
- `setXrOptions(environment: LIVING_ROOM_NIGHT)` and a raw numeric equivalent returned success but left `getXrOptions` at `LIVING_ROOM_DAY`. Settled before/after captures were byte-identical and were visually inspected. The RPC is a measured no-op on this build, so it must not become an `emulator_boot` option.
- Host `/usr/sbin/screencapture -v -V1 -l127439` produced a valid 363,905-byte H.264 MP4 of the PICO emulator window. An extracted frame was visually inspected and showed the live gallery.
- Calibrated with explicit tool payload `0.13`, W/S motion at holds of at least 200 ms is `1.125 m/s`, quantized in approximately `0.01125 m` ticks. Right-drag yaw is `0.1000001 degrees` per CoreGraphics coordinate unit and pitch is `0.1000003 degrees` per unit. These are differential calibrations for the measured emulator/host input path, not absolute-pose persistence guarantees.
- Key motion can begin 1.5-2.2 seconds after key release and settle 2.9-3.6 seconds after it. The existing settle loop can accept two identical old frames before motion begins.
- `setXrOptions` and camera experiments also confirmed that global gRPC proto loading is not keyed by requested tool version. A later explicit `0.13` call can reuse whichever version was loaded first.

Session capture evidence for the visual statements above:

- Environment baseline: [`xroptions-before.png`](/tmp/pico-render/xroptions-before.png)
- Settled NIGHT request result: [`xroptions-night-2.png`](/tmp/pico-render/xroptions-night-2.png)
- Settled raw-numeric request result: [`xroptions-rawnumeric.png`](/tmp/pico-render/xroptions-rawnumeric.png)
- Extracted host-video frame: [`pico-mcp-host-video-probe-frame.png`](/tmp/pico-mcp-host-video-probe-frame.png)
- Camera calibration captures and raw trials: [`pico-camera-cal-20260809`](/tmp/pico-camera-cal-20260809)

These `/tmp` paths are session evidence, not durable repository fixtures. Final verification records durable capture references through `record_verification` before making new visual claims.

## Protected invariants

- `appskeleton/gradle/libs.versions.toml` stays on the PICO `0.13.3` BOM.
- No automatic network generation or paid Meshy regeneration is performed. Request-shape changes are deterministic tests; every delivered model remains independently measured.
- Existing raw camera controls remain backward compatible.
- A tool result, build, hash, or score never becomes a visual claim. Every visual assertion links to a capture that a vision-capable agent actually opened.
- Live emulator calls target `emulator-5554`. Camera changes always settle before judgment.
- `.dev` remains local and ignored. Supported distribution behavior is tested in tracked source; this wave does not force ignored harnesses into the package.
- Existing user work, including the pre-existing untracked `evidence-frame-drift-2026-08-08.png`, is preserved.

## Architecture

### 1. Structured AppSpec transport

Introduce a reusable permissive AppSpec transport schema that advertises JSON `type: object` while leaving semantic validation to the existing full `appSpecSchema.safeParse` path. Planner `draftSpec`, compiler `spec`, and the doors build facade use this transport schema instead of `z.any()`.

The transport boundary does not coerce JSON strings and does not expose a string-or-object union. Advertising a string alternative would allow schema-guided hosts to keep choosing the failing representation. It also does not install the fully refined AppSpec schema as the MCP input boundary, because MCP-level rejection would bypass the planner/compiler's useful schema hints and recovery response.

Tests inspect `listTools` output for an object schema, preserve current custom validation errors for malformed object drafts, and execute brief-only scaffold -> object plan -> compile. Live verification repeats both `.dev/mcp-call.mjs` and the failing headless `claude -p` path.

### 2. Cache-isolated textured baking

`bakeTexturedModel` becomes the single isolation seam for model baking:

1. Stage the source as it does today.
2. Create a unique OS-temporary output directory.
3. Run `spatialbundle pack -o <temporary-output>/<name>.bundle`.
4. Inspect and validate the staged bundle.
5. Create the requested destination parent and copy only the completed `.bundle` to it.
6. Remove the full temporary stage in `finally`, including PICO's adjacent `BundleCache`.

The implementation uses Node filesystem APIs (`mkdtemp`, `copyFile`, `rm`) rather than shell moves or POSIX-only paths. Copying, not renaming, handles cross-volume temp directories on Windows. Pack or validation failure does not alter an existing requested bundle. Direct bake, catalog import, and surface placement inherit this behavior without duplicating cleanup.

A hermetic injected/fake packer test creates a synthetic `BundleCache` beside its staged output and asserts that only the bundle reaches the destination. The live 0.13 integration bakes a copied GLB under a disposable directory and proves that the target assets tree has no `BundleCache`.

### 3. One raw-model path vocabulary

`structural_asset_gate` accepts `modelPath` as its preferred argument and retains `assetPath` as a deprecated compatibility alias. At least one is required. If both are present and resolve to different paths, the call fails rather than guessing.

The documented raw-model sequence is:

1. `structural_asset_gate({modelPath})` rejects unsupported or unsafe structure.
2. `measure_model({modelPath})` establishes size, origin, and `baseLift`.
3. `bake_textured_model({modelPath, outBundle})` creates the runtime asset.
4. Bind, render, settle-capture, and LOOK.

Gate and measurement remain independently callable prerequisites; catalog import is not silently turned into a policy gate in this wave.

### 4. Honest recording and host video

`capture_record` keeps its official pico-cli lane for devices and unknown future emulator builds, but first fingerprints the selected target. The known broken PICO emulator build returns a fast structured diagnosis without spending the requested duration. Its response includes the guest failure signature and directs macOS callers to `capture_video`.

A small host-window abstraction owns emulator-window discovery instead of adding another qemu lookup. Its portable interface supports finding a window and recording it; the first adapter is Darwin. The Darwin recorder invokes the measured command shape:

```text
/usr/sbin/screencapture -v -V<seconds> -l<CGWindowID> <output.mp4>
```

`capture_video` accepts duration, output path, and an optional explicit window ID. It returns the exact selected window, output path, byte count, and validation status. It rejects missing/empty output and, when `ffprobe` is available, reports container, codec, duration, and dimensions. Absence of `ffprobe` weakens metadata reporting but does not make a nonempty file visually verified.

Non-Darwin hosts return `status: unavailable`, `platform`, and the Windows adapter contract (`EnumWindows`/window capture plus a native recording backend) without importing or spawning macOS utilities. The future Windows implementation retains the tool schema.

### 5. Harness and tool-payload freeze

The effective PICO tool-payload version resolves in this order:

1. explicit `toolsVersion` argument;
2. `PICO_TOOLS_VERSION` environment variable;
3. repository default `0.13`.

Missing pinned payloads fail with an exact remedy rather than falling forward to `6.0`. `validate_toolchain` reports both the effective request and its source. `pico_doctor`, preflight, baker, emulator, editor, workflow, ADB, and gRPC use the shared resolution path where they currently use version discovery. The gRPC proto/client cache is keyed by effective version so explicit 0.13 calls cannot reuse a previously loaded 6.0 proto.

The app BOM remains `0.13.3`; tests assert it. Explicit `toolsVersion: "6.0"` and `PICO_TOOLS_VERSION=6.0` remain conscious opt-ins for a later freeze decision.

For local ignored harnesses:

- `call-tool.mjs` gains validated `PICO_TOOL_TIMEOUT_MS` and passes `timeout` plus `maxTotalTimeout` to `client.callTool`.
- `call-tool-long.mjs` is left functionally unchanged because both fixes are already present.
- `run-battery.mjs` gains validated `PICO_BATTERY_TIMEOUT_MS`, defaulting to its current ten minutes, and logs the effective process budget.

Local after-verification explicitly exercises all three siblings. A harmless sentinel `PICO_HOME` value passed to `validate_toolchain` proves environment propagation without consuming a hosted-generation credit. Both MCP callers run a bounded read-only `watch_crash` window longer than 60 seconds with a larger `PICO_TOOL_TIMEOUT_MS`, proving the SDK default no longer kills the call. The battery runner is exercised against a disposable package with a deliberately longer test and a short `PICO_BATTERY_TIMEOUT_MS`, proving that its configured process budget—not a hard-coded ten minutes—is enforced. `node --check` covers every edited or confirmed-unchanged harness.

### 6. Meshy evidence and origin semantics

The Meshy preview request sends `auto_size: true` with `origin_at: "bottom"`. Request-shape tests lock both fields together. Cache identity includes the effective sizing/origin options so requests with materially different geometry policy do not alias old assets.

Tool descriptions, responses, metadata, and honesty notes say:

- The Meshy preview -> refine -> GLB network flow was live-exercised on 2026-08-09.
- The delivered jade was 24.5 MB and arrived centre-origin because the old request omitted `auto_size`.
- The corrected origin request shape is deterministic/source-verified but not paid-live-reverified in this wave.
- `origin_at` is a request, never evidence. Every model must pass `structural_asset_gate` and `measure_model`; callers use measured `baseLift` rather than an assumption.

Cached historical metadata is not rewritten to falsely claim bottom origin.

### 7. Calibrated camera and rig

Create a pure calibration layer and keep device/platform drivers separate:

```text
MetricCameraController
  -> GrpcWalkDriver                  # host-neutral, explicit toolsVersion
  -> HostLookDriver
       -> DarwinCgEventLookDriver
       -> WindowsSendInputLookDriver # unavailable stub in this wave
```

The measured calibration record is keyed by emulator fingerprint, effective tools version, drag interpolation (`steps=24`, `delayMs=14`), and host coordinate system. It stores:

- walk speed `1.125 m/s` for W/S holds at least 200 ms;
- practical walk uncertainty `+/-0.01125 m` at or above 200 ms;
- yaw `0.1000001 degrees/CG-coordinate-unit`;
- pitch `0.1000003 degrees/CG-coordinate-unit`.

Existing `{key, holdMs, repeat}` and `{dragDx, dragDy}` inputs remain unchanged. Semantic alternatives are mutually exclusive with their raw equivalents:

```json
{ "moveMeters": 0.45, "direction": "forward" }
{ "turnDegrees": 10, "axis": "yaw" }
```

The controller reports requested value, rounded raw command, expected movement, calibration key, and uncertainty. Initial metric translation supports only calibrated forward/back W/S. Requests below 0.225 m are rejected or require an explicit low-confidence opt-in because timer/tick phase dominates short holds. `moveMeters` is camera-local path length; a pitched view can include vertical movement.

Settling becomes a state machine with a pre-motion frame. After a requested motion it must observe a different frame before an identical pair can count as settled. The sequence `old, old, new, moving, final, final` returns `final`; it never returns `old`. A no-change timeout is classified separately from a settle timeout.

`capture_rig` reuses the shared walk/look/settle controller. It removes the hard `-1000/+recoverDy` pitch ritual and fixed 400 ms sleeps. The initial rig supports optional calibrated W/S legs and measured yaw sweeps, captures only after observed-change settle, inverts each leg, and reports round-trip residuals. Image scores remain ranking-only; the caller still opens the selected frames. `gui_camera` remains available but is marked legacy only after the replacement live path passes.

The guest HMD pose test binary may be wrapped as optional diagnostic instrumentation, but semantic movement remains usable open-loop with its stated uncertainty. Absolute pose is not promised across app/session transitions.

### 8. `setXrOptions` measured refutation

No environment option is added to `emulator_boot`. `xr_set_options` documentation and response honesty record that the current 0.13 emulator accepts the RPC but does not apply the requested home environment. Return code is not presented as state change. A regression keeps the RPC callable for future builds and encourages read-back plus settled visual verification when the fingerprint changes.

### 9. Real panel clicks

`click_panel` is a one-shot real host-pointer action, not a DEBUG/AGENT_CMD broadcast. Existing AGENT_CMD selection remains only a control for the application's downstream data path.

A host-pointer interface composes with shared window discovery:

```text
PanelTargetResolver -> HostWindowCapture/OCR -> HostPointerDriver
                                              -> Darwin CGEvent
                                              -> Windows SendInput (future)
```

For `label`, the Darwin adapter uses Vision OCR on the current host-window capture, normalizes text, and requires one exact high-confidence match. Zero or multiple matches fail closed. Before any global event is posted, it brings qemu frontmost, re-enumerates and re-captures the selected window, re-resolves the OCR target, and verifies that the window identity/bounds are unchanged and that the selected emulator window is the foremost on-screen window owning the click coordinate. Any focus, ownership, occlusion, movement, or ambiguity check failure aborts without clicking. Only then are image coordinates mapped to current CGWindow bounds and a stationary left-down/left-up event posted at the matched text box centre.

For `id`, the resolver first uses an optional supplied catalogue path. Otherwise it discovers the foreground package, locates/pulls the installed APK into a temporary directory, and scans packaged JSON assets for an unambiguous object containing that ID and a visible `short`, `label`, `title`, or `name`. It then uses the resolved visible text through the same OCR path. It never guesses that an internal ID is rendered text. Temporary APK/catalog extraction is cleaned in `finally`.

The response records the resolved label, OCR confidence/bounds, window ID, click coordinate, and action status. It does not claim the application callback ran. Live verification requires a settled before capture with the pill visible, the click, a newly settled after capture, and visual inspection of the expected detail state. No gallery source change is required.

### 10. Portable scaffold instructions

`scaffold_spatial_app` gains `agentsMd?: boolean`, default false. A packaged portable template outside the copied skeleton contains only reusable PICO rules:

- PICO SDK 0.13.3 baseline and existing selected stage style;
- PICO SpatialUI/theme and baked-bundle guidance;
- preflight/lint before writes and lifecycle cleanup;
- generator-first, small verifiable increments, and guard preservation;
- measure model scale/origin;
- settle-capture and LOOK before visual claims.

It excludes museum artifacts, learner branches, instructor checkpoints, transfer tasks, and a forced Mixed-stage policy.

For generated skeletons, `agentsMd:true` creates `<target>/AGENTS.md`. For template clones, it preserves existing instructions by inserting an idempotently marked portable section; repeated scaffolding does not duplicate it. The response reports `agentsMdPath` and `created` or `merged-existing`. `agentsMd:false` preserves current behavior exactly.

The template is included in the npm `files` allowlist and gets its own installed-package/tarball canary rather than being incorrectly treated as an app-skeleton canary.

## Error and safety behavior

- Nested AppSpecs reject string transport instead of silently parsing arbitrary text.
- All temporary bake, APK, capture-validation, and Swift/helper artifacts use exact task-owned directories and clean up in `finally`.
- External processes have bounded timeouts and bounded diagnostic output.
- Caller-selected output paths are expanded and validated consistently; tools do not write into the protected deliverable repositories during verification.
- Known guest-video failure returns a diagnosis before waiting for the requested recording duration.
- OCR clicking fails closed on ambiguity, missing visibility, permissions, or unsupported platform.
- Camera movement reports a no-change timeout, unsettled tail, version mismatch, and session discontinuity instead of returning a misleading settled capture.
- macOS imports/processes are selected at runtime behind adapters. Platform-neutral modules remain loadable and testable on Windows.

## Test strategy

Implementation is red-green-refactor, with focused tests before each behavior change.

Deterministic coverage includes:

- AppSpec tool JSON Schema, planner/compiler/doors object flow, and custom malformed-object hints;
- cache-isolated bake success/failure/cleanup and catalog propagation;
- gate `modelPath`, compatibility alias, conflict behavior, and sequence documentation;
- known-emulator guest-record fast diagnosis and Darwin/Windows host-video selection;
- tool-version precedence, missing pin failure, 0.13.3 BOM invariant, and version-keyed gRPC cache;
- harness syntax, environment propagation, greater-than-60-second MCP call completion, and configurable battery process-timeout enforcement;
- Meshy preview/refine request fixtures and honesty/status vocabulary;
- camera conversions, sign/rounding/uncertainty, raw compatibility, observed-change settle, and rig command ordering;
- `setXrOptions` honesty metadata without a boot option;
- OCR normalization/ambiguity, ID-to-visible-label resolution, coordinate mapping, and platform driver selection;
- AGENTS template content, create/merge/idempotence/no-op behavior, installed-package canary, and forbidden course-specific text.

## Live verification

After focused tests and `npx tsc`, use the built stdio server exactly as an agent would:

1. Re-run `pico_doctor` and confirm effective tool payload `0.13` plus app BOM `0.13.3`.
2. Repeat direct AppSpec plan/compile, then the headless `claude -p` call. Inspect actual tool argument types and complete an end-to-end compile.
3. Bake a copied real GLB via direct bake and catalog import. Assert bundle validity and inspect the target tree for absence of `BundleCache`.
4. Call `measure_model` and `structural_asset_gate` with the same `modelPath`, then bake it.
5. Call `capture_record` on the known emulator and confirm a fast structured diagnosis. Call `capture_video`, probe the MP4, extract a representative frame, and LOOK at it.
6. Exercise W/S 0.225/0.45/0.675 m and signed yaw/pitch turns. Require an observed pixel change before identical-pair settle, compare optional pose telemetry within calibration uncertainty, and LOOK at final/round-trip captures.
7. Run the upgraded capture rig; LOOK at every frame used for a visual claim.
8. Preserve the existing settled before/after `setXrOptions` refutation as structural/visual evidence; do not relabel it success.
9. Settle the gallery, LOOK at a unique visible pill, invoke `click_panel`, settle again, and LOOK at the detail-state capture. Use AGENT_CMD only as a separate control.
10. Scaffold disposable generated/template projects with and without `agentsMd`, inspect their output, run existing deterministic batteries, smoke, packaging validation, and TypeScript compilation.
11. Exercise each sibling harness as specified in section 5, then call `record_verification` with the evidence class actually earned and the exact durable capture references for every new visual claim.

Only captures actually opened by a vision-capable agent can support `vision_verified`. Camera telemetry is structural evidence; heuristic image scoring is at most `auto_judged`.

## Dependency and commit order

1. `v36.2: specify the measured Week-1 runbook hardening wave`
2. `v36.3: make AppSpecs, raw models, and 0.13 baking agent-safe`
3. `v36.4: diagnose guest recording and prove host-window video`
4. `v36.5: record the live Meshy result and calibrate camera motion`
5. `v36.6: click real panels and scaffold the proven agent rules`
6. `v36.7: publish the visually checked Week-1 verification evidence`

Each implementation commit states what was measured, what was refuted, and what remains platform- or live-unverified. The ignored `.dev` harness changes are reported in the handoff but are not falsely attributed to a tracked commit.
