# Unity & OpenXR with pico-spatial-mcp — the evidence-bounded lane

This page separates the shipped Unity/APK handoff from dated emulator observations. Historical
attestations are not current visual proof when their retained image bytes are missing or fail hash
revalidation. No flow documented here was run on Swan hardware or on a native Windows host.

## The shipped Unity lane

The seam between a Unity toolchain (Editor, batchmode, CLI, or Unity-focused MCP) and this server is
the APK boundary plus an optional drive contract:

1. **Handoff:** `{apkPath, packageName}` is the input expected by `verify_pico_apk`. An installable
   arm64 APK satisfies the structural handoff.
2. **Drive contract (optional):** a scaffolded app listens for the
   `<applicationId>.DEBUG_CMD` broadcast and forwards its `cmd` string to C# through
   `UnitySendMessage`. The built-in commands are `ping`, `color:<html-color>`, and
   `spin:<on|off>`.
3. **Evidence:** build, install, launch, logcat, PID, and frame-submission markers are structural.
   A visual claim additionally requires a suitable capture that someone actually LOOKED at and
   whose stored bytes still pass ledger revalidation.

Two tools implement this side of the seam:

- **`unity_scaffold_project`** emits the packaged Unity project skeleton. The default is a 2D
  windowed app; `immersive: true` selects the OpenXR configuration. `spatialAdapter` supplies a
  guarded adapter initialization slot.
- **`unity_build_apk`** invokes the repository's batchmode `PicoBuild.Apk` path and reads its
  structured `build-result.json`. Build success does not prove rendered appearance. Hand the APK to
  `verify_pico_apk`, then LOOK at the returned or alternate capture.

Ledger `com.picoagent.hellounity#0` retains a historical looked-at attestation for the windowed
scaffold (including a live color-change command), but its linked image is now missing. The current
reader reports `provenance-broken`, not `vision_verified`. Seq 1 remains structural evidence for the
focus behavior observed in that run: commands can reach the Java receiver while an unfocused panel's
Unity player loop is paused, then drain when focus returns.

## Practical boundary

- **Build:** the repository has a scriptable Unity Android batchmode lane. Treat any newer Unity CLI
  surface as unverified until its installed `--help` and an actual invocation are measured.
- **Install, launch, and observe:** `verify_pico_apk` installs on its hardcoded emulator serial,
  launches, checks process/crash signals, and captures an adb frame. These are structural results.
- **Capture:** there is no universal “windowed uses adb; immersive uses host window” law in the
  retained evidence. Historical runs showed that asymmetry, while a later same-moment immersive run
  produced a non-black adb frame. A black adb frame is therefore inconclusive. Collect both adb and
  an alternate host-window capture such as `gui_capture` when available, scope them to the same
  launch, and LOOK before deciding what rendered.
- **Hardware:** `device_verified` requires the live identity and exact same-serial capture-binding
  protocol in [DEVICE_VERIFICATION.md](DEVICE_VERIFICATION.md). That protocol has not run on Swan.

## SDK choices represented by the dated tests

The repository's dated test fixtures used these separate routes:

| Route | Package/version used | Evidence boundary |
|---|---|---|
| PICO Unity Integration SDK | `com.unity.xr.picoxr` 3.4.0 at `c93a59b` | Historical emulator run; retained visual bytes missing. |
| PICO Unity OpenXR SDK | `com.unity.xr.openxr.picoxr` 1.4.1 from the `release_1.4.0` lineage at `3aa3e62` | Structural session evidence plus historical looks whose bytes are missing. |

Do not install both routes into one project without first resolving their native-plugin and assembly
collisions. Which route PICO recommends for a new project is outside this repository's measured
evidence.

### Setup findings from the dated OpenXR test

- The tested OpenXR package needed an explicit `com.unity.ugui` dependency.
- The tested package emitted controller manifest metadata unconditionally; inspect generated
  metadata rather than accepting it unnoticed.
- An incumbent Full-Space owner can block a later immersive activity. Stop it and then confirm the
  tested package's PID/session.
- Full-Space teardown was asynchronous in the measured emulator run; the repository's verifier uses
  a force-stop-to-start delay.
- Telemetry supports a claim only when tied to the tested launch's package and PID. Stale or
  cross-package compositor lines prove nothing about the APK under test.

## Verification workflow

1. Build the APK through batchmode or another Unity builder.
2. Release an incumbent Full-Space owner and run
   `verify_pico_apk { apkPath, packageName }`.
3. Tie logcat to the current package/PID. Session state, advancing frames, and an app-owned layer are
   structural evidence, not a pixel result.
4. Capture adb output and, where possible, an alternate view of the same launch. Treat black adb
   pixels as inconclusive. LOOK at expected app content, not merely “not black.”
5. Record only the tier earned. `vision_verified` needs the looked frame and attestation;
   `device_verified` additionally needs the unexercised live-hardware protocol.

## Dated emulator observations and current provenance

### 2026-07-22: healthy session, black adb frames

The OpenXR settling test observed a live process, PICO runtime load, session transitions through
focused state, an active display, advancing frame counters, and an app-owned layer. Three adb
captures were uniformly black. Those pixels established only that expected content was absent from
that capture path; they did not locate a renderer or compositor failure.

### 2026-07-29: host-window looks

Two historical attestations report full-immersive content in the emulator host window:

| Route | Package | Historical host-window observation | Historical same-moment adb observation |
|---|---|---|---|
| Integration SDK / `PXR_Loader` | `com.picoagent.pxrvr` | Intended colored scene filled the view. | Black. |
| OpenXR SDK | `com.picospatial.helloopenxr` | Intended scene filled the view. | Black. |

Those rows are `com.picoagent.pxrvr#0` and `com.picospatial.helloopenxr#3`. Their retained image
files are missing, so both now read as `provenance-broken`. The attestation prose remains historical
context, not current visual proof.

### Later cold-restart run: the blanket rule was refuted

A later `com.picospatial.helloopenxr#4` attestation reports a non-black adb capture of the same
immersive scene at the same moment as host-window captures. Its retained image is also missing, so
the visual row is currently `provenance-broken`; nevertheless, the recorded comparison is enough to
show why public docs must not present the earlier adb-black pattern as a universal capture rule.

The safe operational conclusion is narrower:

- adb and host-window captures are different observations;
- a black adb frame alone establishes neither render failure nor capture-path failure;
- session/log markers do not replace a visual LOOK; and
- current visual proof requires a fresh capture whose stored bytes remain intact.

## What remains open

The 2026-07-02 native-NDK and WebXR immersive probes were judged through a single capture path and
have not been repeated with the corrected evidence discipline. Their visual conclusion remains open.
Likewise, controller-ray input, head-tracked depth, Guardian behavior, Swan capture behavior, and a
native Windows Unity flow have not been measured by this repository.

## Next evidence worth collecting

- Re-run the unchanged windowed and both immersive APKs; capture adb and host-window views from the
  same launch, LOOK at each, and store the accepted bytes through the ledger.
- Exercise `device_verified` on Swan only with the exact live identity/same-serial capture protocol;
  report whether byte equality is practical for a stable frame.
- Measure any Unity CLI flags against the actual installed version before scripting them.

Until those measurements exist, the Unity lane is build/install/session-capable structurally, with
historical looked-at attestations whose current pixel provenance is broken—not a current claim that
native, web, or hardware output is ship-ready.
