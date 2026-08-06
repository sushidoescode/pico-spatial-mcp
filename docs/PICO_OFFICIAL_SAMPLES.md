# PICO's official Spatial SDK samples — the 0.13.3 reference rig

All eight of PICO's official samples build and run on the PICO OS 6 emulator at **SDK 0.13.3**, with
no patching. Verified 2026-08-06 on `emulator-5554`: 8/8 launched, every one looked at
(trust ledger `pico-official-samples-0.13.3#0`, `vision_verified`).

They are the best available reference for "what does PICO's own idiom look like" — and the only
reference that matches what we target.

---

## Get them from the right place

**Two distribution channels, and only one is 0.13.3.**

| Channel | Version | Usable here? |
| --- | --- | --- |
| `github.com/Pico-Developer/PICO-Spatial-SDK-Sample-*` | **6.0.0 only** (`main`, `release/6.0.0`, tag `v6.0.0`) | **No** — see the version rule below |
| `lf-devtools.picoxr.com/obj/spatial-toolbox/examples/<name>-0.13.3.zip` | **0.13.3** | **Yes** |

The 0.13.3 archives are what the docs site serves when you switch its version selector to `0.13.x`
(`developer.picoxr.com/document/spatial-example/overview/?v=0.13.x`). They are not on GitHub.

```bash
for n in welcomespace animation physics spatialvideo spatialaudio spatialmesh spatialml spatialui; do
  curl -sSL -O "https://lf-devtools.picoxr.com/obj/spatial-toolbox/examples/$n-0.13.3.zip"
done
```

> **Do not infer a sample's version from a working tree.** A local clone of WelcomeSpace once carried
> an uncommitted downgrade to `0.13.3` that an earlier agent had made to get it to build; a report
> then cited it as proof that PICO ship a 0.13.3 sample on GitHub. They do not. Always
> `git -C <sample> log --oneline -1 && git -C <sample> diff` before citing a sample file.

---

## The version rule that blocks everything

PICO's `com.pico.spatial.tools` Gradle plugin **refuses a mismatch between the installed Spatial
Editor and the project's Spatial SDK**:

```
> Spatial Editor version (0.13.4) and Spatial SDK version (6.0.0) are not compatible.
  They must have the same first two segments.
```

So with Spatial Editor `0.13.x` installed (`~/Library/PICO/sdk/0.13/editor/`), you can build 0.13.x
samples and **cannot** build the 6.0.0 ones. `pico-cli` has no command to fetch editor tools — it
installs *emulator bundles*, which are a different thing.

**This is a build-toolchain constraint, not (as far as measured) a runtime one.** With the
`editor-asset` module removed, the Physics sample compiled against BOM 6.0.0, installed, created its
spatial container and reached foreground on the 0.13.2 emulator runtime — then failed only on
`asset://editor-asset.bundle`, the asset that removal had deleted. A 6.0.0 app initialises fine
against a 0.13.2 runtime.

---

## Build and run one

```bash
unzip -q physics-0.13.3.zip -d physics && cd physics/physics-0.13.3
printf 'sdk.dir=%s/Library/Android/sdk\nspatial.tools.dir=%s/Library/PICO/sdk\n' "$HOME" "$HOME" > local.properties
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew :app:assembleDebug          # SpatialML's module is :SuperResolutionApp, not :app

adb -s emulator-5554 install -r app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 shell input keyevent KEYCODE_HOME     # clear any Full-Space incumbent first
adb -s emulator-5554 shell monkey -p com.pico.spatial.sample.physics -c android.intent.category.LAUNCHER 1
```

**Traps:**
- `am start` is refused while another app holds Full Space (`current full space don't allow start
  fullscreen`). Force-stop spatial incumbents **and** press HOME first, or use `monkey`.
- **SpatialML does not build as shipped** — in *either* distribution. Its wrapper is
  `gradle-8.10.2` while its AGP 8.9.1 requires `>= 8.11.1`. Fix:
  `sed -i '' 's|gradle-8.10.2-|gradle-8.11.1-|' gradle/wrapper/gradle-wrapper.properties`.
  Reported upstream; a one-line fix on PICO's side.

---

## What each one demonstrates

| Sample | Package | Shows |
| --- | --- | --- |
| **WelcomeSpace** | `…sample.welcomespace` | **The multi-container shape.** Three containers in one `mainApp` — Planar `DefaultWindowContainer`, Volumetric `WindowContainer`, `Stage` — navigated via `LocalSpatialNavigator` with a `Bundle` passed between them. The Week-1 parity target; `generate_container_app_kotlin` is modelled on it. |
| **SpatialUI** | `com.pico.spatialui.sample` | The component showcase: gaze-following `TabBar` (`followViewpoints`) floating above the window, `RichCoachmark`, cards, avatars, `SideNavigation`. |
| **Physics** | `…sample.physics` | Dominoes + the **`AttachmentPanel`** "Start" button at `Vector3(0f, -0.3f, 0.28f)` — Compose placed inside the 3D scene. Also collision events, filters and response modes. |
| **Animation** | `…sample.animation` | Tween + **skeletal** animation with a five-clip picker (`findSkinnedMeshEntity` / `getAnimationResources`). |
| **SpatialMesh** | `…sample.spatialmesh` | **Live per-object room mesh** via `MeshTrackingManager.subscribeAnchorUpdate` (never `loadAllAnchors`), drawn as segmented wireframe over the real room. Plus an ECS `System`. |
| **SpatialAudio** | `…sample.spatialaudio` | `AudioResource.load` + `Entity.prepareAudio` + `AudioPlayerController`, in a fully virtual Stage, with a secondary `WindowContainer` opened on `ON_RESUME`. |
| **SpatialVideo** | `…sample.spatialvideo` | Video playback with a transport toolbar and a Stage opened via `openStage(id, StageStyle.Mixed)`. |
| **SpatialML** | `com.pico.spatial.ml.sample.sr` | SecureMR vs RelaxMR camera-access modes; on-device super-resolution. |

---

## How to use them

They are an **idiom** source, not an existence source. A symbol exists for us only if it is in a
**0.13.3 sources jar** (`~/.gradle/caches/modules-2/files-2.1/com.pico.spatial*/**/*-sources.jar`) —
`vault_api` and `preflight_lint`'s vault stage check exactly that. Read the samples to learn *how*
PICO compose an API; confirm *that* it exists against the jar.

Our own conformance diff against these samples is
`.dev/findings/SAMPLES_CONFORMANCE_2026-08-05.md`, and what it changed in our codegen is in
`.dev/handoffs/HANDOFF_2026-08-06_SAMPLE_CONFORMANCE.md`.
