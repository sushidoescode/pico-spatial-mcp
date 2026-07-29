# Unity & OpenXR with pico-spatial-mcp — the honest lane

*(Research- and direct-test-grounded 2026-07-22, extended 2026-07-28 with the SHIPPED Unity lane;
every claim below is labeled by how it was checked. This page documents what works TODAY on the
PICO OS 6 emulator, the Unity hello-XR test of the open compositing question on emulator 0.13.1,
and the v30 seam tools.)*

## The shipped Unity lane (v30) — the seam

The seam between ANY Unity toolchain (Editor, batchmode, the Unity CLI, a Unity MCP) and this
MCP is the **APK boundary** plus one optional drive contract:

1. **Handoff:** `{apkPath, packageName}` — exactly what `verify_pico_apk` takes. Any producer of
   an installable arm64 APK satisfies the seam.
2. **Drive contract (optional):** the app listens for the `<applicationId>.DEBUG_CMD` broadcast
   (string extra `cmd`) — the identical channel every generated native app carries. Scaffolded
   apps get it via a 40-line `Plugins/Android` Java shim forwarding to C# over `UnitySendMessage`
   (built-ins: `ping`, `color:<html-color>`, `spin:<on|off>`; extend via `PicoAgentBridge.Commands`).
3. **Evidence tiers (engine-agnostic):** 2D/windowed Unity content → `vision_verified` is
   attainable today; immersive OpenXR on emulator 0.13.x → `structural` ceiling; Swan/6.1 →
   `device_verified` when reachable.

Two tools implement our side (build and verify stay separate by design):

- **`unity_scaffold_project`** — emits a complete Unity project from a packaged ~11-file
  skeleton (all Unity configuration is applied programmatically at build time by
  `Assets/Editor/PicoBuild.cs`; editor pinned 6000.4.9f1). Default = **2D windowed**; add
  `immersive: true` for the OpenXR config; `spatialAdapter` injects PICO's (pending)
  SpatialAdapter packages — scoped registry, git URLs, or `file:` tarballs — behind a
  `PICO_SPATIAL_ADAPTER` define with a ready init slot (`SpatialAdapterSlot.cs`).
- **`unity_build_apk`** — the confirmed `-batchmode -executeMethod PicoBuild.Apk` path with a
  structured `build-result.json` contract and pointed fixes for the known traps (license,
  Android modules, scaffold drift). Then `verify_pico_apk`, then LOOK.

**Vision-verified 2026-07-28** (trust ledger `com.picoagent.hellounity` seq 0): the windowed
default scaffold builds (41s cold / 12s warm on the reference machine), installs, and its scene
**composites as a floating panel** on the emulator — cyan sky, white floor, red cube (recolored
live by a `DEBUG_CMD color:red`, the drive proof), yellow sphere, green capsule.

**The focus gate (know this before driving a Unity panel)** — measured, seq 1 (structural): the
shell keeps an **unfocused** panel's activity paused, so the Unity player loop runs only while
the panel has focus. Broadcast commands always reach the Java receiver and **queue**, draining
in order when focus arrives; first frame can lag launch by ~60s until the shell grants focus (an
input tap does it immediately). Plan captures and `expectLogcatContains` accordingly: a healthy
launch can legitimately show no Unity-side scene logs until focus.

## TL;DR

- **Build**: Unity Android APKs are fully scriptable headlessly today via the stable batchmode
  path (`Unity -batchmode -quit -projectPath <p> -executeMethod <Editor class>.<method>
  -buildTarget android -logFile -`). Unity's brand-new **Unity CLI** (announced at Unite Seoul
  2026, available now) adds structured JSON output and first-class Android export — but its
  exact `build` flag surface is not yet verified here; check `unity --help` before scripting it.
- **Install / launch / logcat / capture on the PICO emulator**: identical to any other APK —
  and this MCP already does it: point **`verify_pico_apk`** at your Unity-built APK and you get
  install → launch → crash-scan → a captured frame. A looked-at frame proves only what its
  pixels show; it does not turn a structurally healthy but visually black XR run into a visual
  success.
- **The boundary**: a Unity app running as a **2D/windowed Android activity** (menus, MR-window
  surfaces, anything not opening an immersive OpenXR session) composites and is visually
  verifiable on this emulator — the same proven panel pipeline used across this repo. The direct
  Unity hello-XR test confirmed that an **immersive OpenXR session** can run and submit an
  app-owned layer at 60fps while its intended scene remains absent from the captured viewport.
  That reproduces the black-output boundary on emulator 0.13.1 / PICO OS 6.0; the test does not
  by itself isolate compositor promotion from an earlier Unity camera/render-target stage, and
  makes no claim about 6.1 or Swan hardware.

## Which PICO Unity SDK?

Two parallel, currently-maintained SDKs exist (confirmed on GitHub):

| SDK | Version | Notes |
|---|---|---|
| **PICO Unity Integration SDK** | 3.4.0 (2026-02-27) | PICO-native, fullest feature set (plane detection, SecureMR, camera APIs). |
| **PICO Unity OpenXR SDK** | release 1.4.0 (2025-06-03) | Unity's OpenXR plugin + PICO provider; XR Interaction Toolkit / XR Hands / AR Foundation; needs PICO system ≥ 5.13.0. The settling test used package `com.unity.xr.openxr.picoxr` 1.4.1 from `release_1.4.0` commit `3aa3e62`. |

**Do not install both in one project** — a Unity Discussions thread (2025-07) confirms
native-plugin collisions (duplicate `libEGL`, assembly-name clashes). Pick one per project.
Which one PICO steers new projects toward is not publicly settled; the marketing framing is
"Integration SDK = full features, OpenXR SDK = cross-platform."

### Setup gotchas found by the settling test

- The official OpenXR package omits its required `com.unity.ugui` dependency; declare/install
  that dependency explicitly before expecting a clean import.
- The package emits controller=`1` manifest metadata unconditionally. Include XR Hands when that
  describes the app, or patch the generated metadata deliberately; do not accept it unnoticed.
- An existing full-space owner can block the Unity activity from entering the space even though
  Android reports a launch attempt. Stop the incumbent first, then confirm the Unity PID/session.
- Full-space teardown is asynchronous: direct automation must wait before relaunching an
  immersive activity. `verify_pico_apk` now enforces a tested two-second force-stop → start gap.
- Treat telemetry as evidence only when it is tied to the same launch's package and PID. Stale or
  cross-package OpenXR/compositor lines do not prove the tested APK reached a session.

## The buildable-today loop (Unity APK → verified on the emulator)

1. Build the APK headlessly (batchmode, or your Unity MCP / the new Unity CLI).
2. Release any incumbent full-space owner, then run
   `verify_pico_apk { apkPath, packageName }` — installs, launches, asserts no crash, captures.
3. Scope logcat to this launch and confirm the target PID, OpenXR session state, running display,
   advancing frames, and app-owned layer before interpreting the capture.
4. LOOK at the capture. For 2D/windowed Unity content, visible app pixels can honestly become
   `vision_verified` via `record_verification`. For immersive content on emulator 0.13.1, the
   healthy runtime result remains `structural`; the looked-at black frame is a negative finding,
   not a visual-success claim.
5. On real Swan hardware, the same loop can mint `device_verified` after a device capture is
   actually looked at — see
   [DEVICE_VERIFICATION.md](DEVICE_VERIFICATION.md).

## Settling result: runtime yes, intended pixels absent from capture

This project's own reverse-engineering (2026-07-02, on the 0.13.x / OS 6.0 emulator) found:
a from-scratch native OpenXR app gets a real tracked 60fps stereo session, but the compositor
never promotes ANY third-party projection layer to the viewport (`PxrCompositor: atw No app
layer`), and the emulator's own privileged WebXR runtime hits the identical failure. That is a
**project-local empirical finding**, not a documented platform fact.

The Unity-specific settling test has now reproduced that boundary with **Unity 6000.4.9f1** and
the official PICO package `com.unity.xr.openxr.picoxr` **1.4.1** from `release_1.4.0` commit
`3aa3e62`, on emulator **0.13.1 / PICO OS 6.0**. The final APK SHA-256 is
`141c974b18dd71625bce3d9c0293c87485ae186cab3b7b96d0f9a349229541bc`.

The runtime path was structurally healthy: PID 23401 remained alive; the PICO runtime loaded;
the session advanced IDLE → READY → SYNCHRONIZED → VISIBLE → FOCUSED;
`xrDeviceActive` and `displayRunning` were true; `renderPasses=1`; `beforeRender` and the frame
counter advanced; and `PxrMetric` reported 60/60 with an app-owned `LayerCnt=1` after a brief
initial value of 2. No crash occurred. Unity's own diagnostic simultaneously reported
`Skip Present To Main Screen: Yes`.

Two same-session 2160×2158 captures were byte-identical, SHA-256
`5cf4d98756168e8d98e61e02e8449d16bc389960af062f938762ac35d9adc060`. The frame was LOOKED at:
it was uniformly black, with none of the deliberately loud cyan, magenta, yellow, or green scene
visible. After fixing the verifier's immediate-relaunch race, a fresh `verify_pico_apk` run
returned `status=ok` (PID 24712 alive, no crash, expected log matched) and produced a third
byte-identical capture; that frame was LOOKED at and was also uniformly black. Therefore the
OpenXR/runtime/session/frame/layer path is **structurally proven**, while the intended immersive
pixels are **absent from capture on this build**. This reproduces the prior native/WebXR symptom,
but does not independently distinguish failed compositor promotion from an earlier Unity
camera/render-target failure. It is not a visually successful or `vision_verified` Unity scene
claim. The looked capture path and attestation remain linked to the structural ledger entry so
the negative finding is auditable without upgrading it into successful visual proof.

PICO's emulator-differences documentation still lists only a bounded set of unsupported
Unity/Unreal/OpenXR features and does not name immersive composition. The Unity reproduction
sharpens that ambiguity for this exact 0.13.1 / OS 6.0 environment; it
does not isolate the failing render stage or establish behavior on a 6.1 emulator or Swan
hardware. Independent unresolved reports of the same black-screen symptom
also exist for Unity OpenXR APKs on Google's Android XR Emulator.

## Roadmap for the lane (see [ROADMAP.md](../ROADMAP.md))

- **Now**: the Unity hello-XR settling test is complete. Build/install/session/layer operation is
  structural on emulator 0.13.1; intended immersive pixels are absent from its capture.
- **Optional next (ungated)**: evaluate a `unity_batch_build` tool wrapping the confirmed
  batchmode path with fix-pointing errors. It would improve the non-immersive/build handoff; it
  would not by itself visually verify immersive output on the current emulator.
- **Watching**: the Unity CLI's `build` verb (verify flags against a live install before
  scripting); Unity's official MCP server surface.
- **Hardware/6.1-gated**: re-test immersive visual composition first thing on a 6.1 emulator or
  Swan hardware. The 0.13.1 result must not be projected onto either untested target.
