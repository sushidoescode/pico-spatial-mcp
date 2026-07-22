# Unity & OpenXR with pico-spatial-mcp — the honest lane

*(Research-grounded 2026-07-22; every claim below is labeled by how it was checked. This page
documents what works TODAY on the PICO OS 6 emulator, what is expected-blocked, and the single
test that would settle the open question. No Unity tools ship in this MCP yet — this is the
documented handoff contract + the roadmap for the lane.)*

## TL;DR

- **Build**: Unity Android APKs are fully scriptable headlessly today via the stable batchmode
  path (`Unity -batchmode -quit -projectPath <p> -executeMethod <Editor class>.<method>
  -buildTarget android -logFile -`). Unity's brand-new **Unity CLI** (announced at Unite Seoul
  2026, available now) adds structured JSON output and first-class Android export — but its
  exact `build` flag surface is not yet verified here; check `unity --help` before scripting it.
- **Install / launch / logcat / capture on the PICO emulator**: identical to any other APK —
  and this MCP already does it: point **`verify_pico_apk`** at your Unity-built APK and you get
  install → launch → crash-scan → a captured frame, with the evidence honestly classed
  (`structural` until someone LOOKS at the capture).
- **The boundary**: a Unity app running as a **2D/windowed Android activity** (menus, MR-window
  surfaces, anything not opening an immersive OpenXR session) composites and is visually
  verifiable on this emulator — the same proven panel pipeline used across this repo. An app
  that opens an **immersive OpenXR session** is *expected* not to composite its projection
  layer to the emulator viewport (see the open question below) — it still installs, launches,
  and produces logcat evidence.

## Which PICO Unity SDK?

Two parallel, currently-maintained SDKs exist (confirmed on GitHub):

| SDK | Version | Notes |
|---|---|---|
| **PICO Unity Integration SDK** | 3.4.0 (2026-02-27) | PICO-native, fullest feature set (plane detection, SecureMR, camera APIs). |
| **PICO Unity OpenXR SDK** | 1.4.0 (2025-06-03) | Unity's OpenXR plugin + PICO provider; XR Interaction Toolkit / XR Hands / AR Foundation; needs PICO system ≥ 5.13.0. |

**Do not install both in one project** — a Unity Discussions thread (2025-07) confirms
native-plugin collisions (duplicate `libEGL`, assembly-name clashes). Pick one per project.
Which one PICO steers new projects toward is not publicly settled; the marketing framing is
"Integration SDK = full features, OpenXR SDK = cross-platform."

## The buildable-today loop (Unity APK → verified on the emulator)

1. Build the APK headlessly (batchmode, or your Unity MCP / the new Unity CLI).
2. `verify_pico_apk { apkPath, packageName }` — installs, launches, asserts no crash, captures.
3. LOOK at the capture. For 2D/windowed Unity content, that look can honestly become
   `vision_verified` via `record_verification`. For immersive content, expect the capture NOT
   to show the stereo scene (below) — the honest evidence stays `structural` + logcat.
4. On real Swan hardware, the same loop mints `device_verified` — see
   [DEVICE_VERIFICATION.md](DEVICE_VERIFICATION.md).

## The open question we want PICO's help with

This project's own reverse-engineering (2026-07-02, on the 0.13.x / OS 6.0 emulator) found:
a from-scratch native OpenXR app gets a real tracked 60fps stereo session, but the compositor
never promotes ANY third-party projection layer to the viewport (`PxrCompositor: atw No app
layer`), and the emulator's own privileged WebXR runtime hits the identical failure. That is a
**project-local empirical finding**, not a documented platform fact.

Meanwhile PICO's own emulator documentation ("differences between the PICO emulator and the
actual device") lists only a *bounded* set of unsupported Unity/Unreal/OpenXR features
(foveation, refresh-rate control, haptics, face/body tracking, VST/SecureMR/MRC…) — immersive
compositing is **not** on the exclusion list, which reads as if baseline OpenXR rendering were
expected to work. The two observations are in tension. Independent (unresolved) reports of the
same symptom exist for Unity OpenXR APKs on Google's Android XR Emulator, so this failure class
is not PICO-specific — but the root cause on the PICO emulator is unsettled.

**The settling test** (the lane's next validation step): a minimal Unity + PICO OpenXR SDK
"hello XR" APK, installed on the emulator, screencapped during an active immersive session.
Rendered content ⇒ our compositor finding is build-specific or fixed; void ⇒ the boundary is
confirmed and this page's "expected-blocked" becomes "confirmed-blocked." Either answer makes
the docs stronger.

## Roadmap for the lane (see [ROADMAP.md](../ROADMAP.md))

- **Now (docs only, this page)**: the handoff contract above — build with your Unity tooling
  (including a companion Unity MCP), verify with this one.
- **Next (ungated)**: the hello-XR settling test; then, if warranted, a `unity_batch_build`
  tool wrapping the confirmed batchmode path with fix-pointing errors.
- **Watching**: the Unity CLI's `build` verb (verify flags against a live install before
  scripting); Unity's official MCP server surface.
- **Hardware/6.1-gated**: immersive visual verification of Unity/OpenXR content — the same
  gate as every other immersive claim in this repo, re-tested first thing when a 6.1 emulator
  or Swan hardware is available.
