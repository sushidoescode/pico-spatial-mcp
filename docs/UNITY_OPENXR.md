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
3. **Evidence tiers (engine-agnostic):** windowed AND immersive Unity content can both reach
   `vision_verified` on emulator 0.13.x — **as long as you capture through the right path**
   (windowed → `capture_frame`/adb; immersive → `gui_capture`, see the corrected section below).
   Swan hardware → `device_verified` when reachable.

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
  pixels show — and only if it came from a capture path that can see the app's mode.
- **The real boundary is the CAPTURE PATH, not the rendering** (corrected 2026-07-29, measured):
  windowed Unity content composites as a floating panel and is captured by adb screencap;
  **immersive Unity VR also composites — it fills the whole view — but adb screencap shows it as
  black**, because Unity stops presenting to the Android main surface (`Skip Present To Main
  Screen: Yes`). Capture immersive content with **`gui_capture`** (the emulator's own window).
  Both Unity XR routes — Integration SDK (`PXR_Loader`) and OpenXR SDK — were LOOKED at rendering
  full-immersive on emulator 0.13.1 / OS 6.0. See the corrected section below.

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
4. LOOK at the capture — **from the right capture path** (see the rule below). For **windowed**
   Unity content, `capture_frame` / `verify_pico_apk`'s adb screencap is correct. For
   **immersive** Unity content, adb screencap returns BLACK by design; use **`gui_capture`**
   (the emulator's own window). Either way, visible app pixels can honestly become
   `vision_verified` via `record_verification`.
5. On real Swan hardware, the same loop can mint `device_verified` after a device capture is
   actually looked at — see
   [DEVICE_VERIFICATION.md](DEVICE_VERIFICATION.md).

## ⚠️ CORRECTED 2026-07-29: immersive Unity VR DOES render — the old finding was a capture-path artifact

**Retracted:** every earlier claim on this page and in this repo that immersive OpenXR content
"does not composite" on emulator 0.13.1. It does. Two Unity apps were run and **looked at in the
emulator's own window** on 2026-07-29, both filling the entire view with their scene (home
environment replaced, no panel, no frame):

| Route | Package | Result (host window) | Same moment via `adb screencap` |
|---|---|---|---|
| **PICO Unity Integration SDK** (`PXR_Loader`, `com.unity.xr.picoxr` 3.4.0 @`c93a59b`) | `com.picoagent.pxrvr` | full-immersive: cyan clear, white floor, magenta cube, yellow sphere, green capsule | **black** |
| **PICO Unity OpenXR SDK** (`com.unity.xr.openxr.picoxr` 1.4.1, the sha-pinned July 22 APK) | `com.picospatial.helloopenxr` | full-immersive: the intended scene, incl. the red bar and checker geometry | **black** |

Ledger: `com.picoagent.pxrvr` seq 0, `com.picospatial.helloopenxr` seq 3 (both `vision_verified`),
`pico-emulator-capture-paths` seq 0 (the rule below).

### The capture-path rule (this is the real boundary)

- **`adb screencap`** (`capture_frame`, `verify_pico_apk`) captures the **shell composite**: the
  home environment, 2D panels, and native Spatial SDK apps (knockdown's lane shows up fine).
- It returns **black for XR-runtime immersive apps** — Unity OpenXR and Unity Integration SDK
  alike. Unity says so itself in the log: `Skip Present To Main Screen: Yes`. The app is
  presenting to the XR display, not to the Android surface screencap reads.
- **`gui_capture`** (the emulator's host window) shows immersive content correctly. For immersive
  verification it is the ground-truth path, not a fallback.

### What is now unknown (do not re-assert either way)

The 2026-07-02 native-NDK/WebXR reverse-engineering concluded from `PxrCompositor: atw No app
layer` that the compositor promotes nothing. Those tests were only ever judged by adb screencap,
so their **visual** conclusion is void; they have not been re-run against `gui_capture`. Whether
that log line means anything at all is now an open question. What is established: two independent
Unity XR routes composite and are visible.

### How the July 22 test misread itself (worth knowing — the same trap catches anyone)

That test built the sha-pinned APK (`141c974b…`), ran it on emulator 0.13.1, and correctly
observed a structurally healthy session: PID alive, PICO runtime loaded, IDLE → READY →
SYNCHRONIZED → VISIBLE → FOCUSED, `xrDeviceActive`/`displayRunning` true, `renderPasses=1`, frame
counters advancing, `PxrMetric` 60/60 with an app-owned `LayerCnt=1`, no crash. Three
byte-identical captures (`5cf4d987…`) were LOOKED at and were uniformly black — and *were read as
a rendering failure*.

The refutation was sitting in the same log: **`Skip Present To Main Screen: Yes`** — Unity
announcing it is not presenting to the Android main surface. That is the surface `adb screencap`
reads. Everything the test measured was true; only the inference from the black frame was wrong,
because a single capture path was treated as ground truth for a mode it structurally cannot see.
On 2026-07-29 the same APK, unchanged, was captured through the emulator window and its scene is
fully visible.

PICO's emulator-differences documentation lists only a bounded set of unsupported
Unity/Unreal/OpenXR features and never claims immersive composition is missing — which now reads
as simply correct, and agrees with the measurements above.

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
