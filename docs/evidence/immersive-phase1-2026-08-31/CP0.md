# CP0 reuse-first world recon

Date: 2026-08-31

Branch: `immersive-phase1-2026-08-31`

Target: `emulator-5554` only
Physical serial `2G0YC5ZF7Z056Q`: not selected or touched

This is the Phase-1 reuse checkpoint for the
[immersive boundary and navigation plan](../../superpowers/plans/2026-08-29-immersive-boundary-and-navigation.md).
It records the exact evidence scope for Claimsight, the eight official 0.13.3 archives, the
priority upstream watch list, and the Polyfork license-first prototype. Heavy frames, downloaded
archives, generated models, bundles, and raw MCP receipts remain outside the repository.

## Decision

- **E1 remains Claimsight.** Its clean manifest-Full build has the strongest Editor provenance and
  the plan already defines its stable landmarks. CP0 closes U10a and U10b for the exact rebuilt
  bytes. U17 closes only for version-qualified 0.13-authored-on-6.0-emulator compatibility; a
  matched 6.0 Editor rebuild remains open.
- **Welcome Space is the only full immersive world in the reviewed official/archive corpus and is
  runnable today.** It built, installed, survived two fresh-launch dialog monitors, dynamically
  opened its Full room, and produced a looked host-composited frame. It is a useful additional
  dynamic-Full reference, but is not a cleaner E1 control than Claimsight.
- **The other seven official archives are feature applications, not reusable worlds.** Five are
  conditional emulator candidates, while Spatial Mesh and Spatial ML require physical-device
  capabilities for their defining behavior.
- **Polyfork permits use inside generated apps, but its asset files must stay out of this public
  repository.** A deterministic four-landmark world was generated externally and baked through
  the real GLB-to-PICO-bundle MCP lane. USDZ remained account-blocked. The GLB lane is the more
  agent-friendly lane for this proof.

## Claimsight: U10a, U10b, and U17

External project: `/Users/sushantsrikrish/AndroidStudioProjects/claimsight`

| Item | Result |
| --- | --- |
| Authored toolchain | Spatial Tools plugin 0.13.1, `spatialToolsVersion=0.13`, SDK BOM/runtime metadata 0.13.3, bundle export 0.13.2, scene metadata naming Spatial Editor `V0.10.2-alpha.3` |
| Clean build | MCP `gradle_build clean --no-build-cache`, then MCP `build_and_run :app:assembleDebug`; authored source snapshot was unchanged |
| APK | `/Users/sushantsrikrish/AndroidStudioProjects/claimsight/app/build/outputs/apk/debug/app-debug.apk`; 38,422,992 bytes; SHA-256 `7ecce31ec0a5ede24c88e97e0aca2ec82dc467f0a639402661b5749ee5678bbf` |
| Bundle | `/Users/sushantsrikrish/AndroidStudioProjects/claimsight/editor-asset/build/spatial/bundle/editor-asset.bundle`; SHA-256 `91df718127968e6592700ecf011bfda118a504a7a2112cb169af8a6c2496c42a` |
| Install binding | Installed `base.apk` SHA-256 exactly matched the host APK; package `com.example.claimsight`, PID 3352, start ticks 7923 |
| Health monitor | Five samples across about 137 seconds; same PID/start ticks, focused/top-resumed, zero crashes, no visible or focused ANR/system dialog |
| Runtime | PICO OS 6.0.0 emulator, boot ID `cbcba1b5-bd2b-485e-ac42-42e3343080aa` |
| Evidence class | `vision_verified`, C0 emulator; ledger artifact `/Users/sushantsrikrish/.pico-mcp/ledgers/artifacts/eda6f367c9686bdbac0b6ed2079cb324f0bb0e466acab559fbfc4a345908faef.png` |

Looked frame:

- `/private/tmp/pico-render/cp0-claimsight/claimsight-settled-baseline.png`
- 2160×2158, 1,270,277 bytes
- SHA-256 `eda6f367c9686bdbac0b6ed2079cb324f0bb0e466acab559fbfc4a345908faef`
- Visible bounded pixels: the app-owned translucent **Full Stage** card, readable body text, a blue
  outlined cube/emblem, and the blue sky/cloud enclosure. No error dialog was visible.

The original imported candidate was not silently accepted: its APK had `android:testOnly=true`
and failed the MCP import precheck with `INSTALL_FAILED_TEST_ONLY`. The clean rebuilt APK above no
longer had that flag. Initial launch attempts then exposed the known wedged Full-Space container
state; MCP `diagnose {symptom:"launch_blocked"}` prescribed a cold emulator restart. Claimsight was the first app
launched after that restart.

Scoped register update:

| ID | Status after CP0 | Remaining limit |
| --- | --- | --- |
| U10a | **Closed for the exact clean APK/bundle/source snapshot above** | Rebuild and rebind if any source or toolchain byte changes. |
| U10b | **Closed for this APK, emulator boot, install, monitor, and looked landmark frame** | No route/boundary outcome transfers from this baseline. |
| U17 | **Compatibility portion closed**: this 0.13-authored row built and rendered on the selected 6.0 emulator | Matched authoring comparison to a 6.0 Editor rebuild remains open. |

## Official downloadable world inventory

The exact archive URLs are maintained in
[PICO_OFFICIAL_SAMPLES.md](../../PICO_OFFICIAL_SAMPLES.md). All eight ZIPs were downloaded to
`/tmp/pico-immersive-phase1/cp0-samples/`, checked for valid central directories, checked for
absolute/parent-traversal entries, and extracted into separate bounded directories. No symlinks
were present.

| Official 0.13.3 archive | Classification | Download/build/run verdict | Archive bytes and SHA-256 |
| --- | --- | --- | --- |
| Welcome Space | **Full immersive environment/world**: browsable furnished room, dynamic `StageStyle.Full` route | **Usable today.** Built with the local 0.13 path, installed and launched on the exact 6.0 emulator, entered the room, monitored, and looked. | 370,700,330; `1544461931b9ad5c0922f2740652734a9ec56df8fd039cb2450e9372eb54c638` |
| Animation | Feature app: skeletal/tween animation viewer | Downloadable; conditional 0.13 emulator candidate; not built or run in CP0 | 30,403,798; `4254f0d427571640a66e9c2429fc26ae5defd068de9f87ceb2bf9fa94267f522` |
| Physics | Feature app: rigid-body/collision playground | Downloadable; conditional 0.13 emulator candidate; not built or run | 31,090,492; `9ab6c022cc519ca92c0488593de1dc2b0566778e938c65ec2beaf66159dac0c8` |
| Spatial Video | Feature app: immersive media player, not a persistent world | Downloadable; conditional emulator candidate with network; streamed sample media has separate reuse restrictions; not run | 2,450,488; `6c27b6e2b0e8529ff822c738d77583f21565774bc0d5007bc27b9e209a0a9479` |
| Spatial Audio | Feature app: immersive jungle Stage used to demonstrate spatial audio | Downloadable; conditional 0.13 emulator candidate; not built or run | 99,334,474; `ff7e3aae3c9f773d4ee7c44c834a217c69f6a5e2ae4c6797191dcd6fd6da14d1` |
| Spatial Mesh | MR sensing/game feature app, not a pre-authored world | Downloadable, but **not usable for its defining live-room-mesh experience on the emulator**; requires a PICO OS 6 device | 10,578,187; `07c40612a68e0c8a8f66f3b0f7f3bc2871e74d17e70e6fe18211b957ccdf8029` |
| Spatial ML | SecureMR/RelaxMR super-resolution feature app | **Not usable as shipped or on emulator.** AGP/wrapper mismatch needs a local wrapper patch; defining behavior requires a PICO OS 6 device | 4,676,262; `a19c522bc9c467c24b737506f4abc0369d38ea2ee476e07fdd071158d0107e48` |
| Spatial UI | Feature app: component/windowing showcase | Downloadable; conditional 0.13 emulator candidate; not built or run | 12,939,500; `e629f5150c89cc89ef1039d546be22fe52e82fccbc8b619e088d15c0c373b551` |

“Conditional” is intentionally weaker than runnable: compilation, dependency resolution,
installation, launch, and pixels were not measured for those rows. A Stage alone also does not
make a reusable world; Welcome Space is the only reviewed archive with the explorable/stateful
environment shape.

All eight archives declare SDK BOM 0.13.3. The five editor-asset samples use Spatial Tools 0.13.1
with the 0.13 family. That makes them candidates for the local 0.13 Editor/toolchain, not evidence
that the local 6.0 Editor can build them. Spatial ML additionally ships AGP 8.9.1 with Gradle 8.10.2,
below its required wrapper version.

### Welcome Space measured addendum

External project:
`/tmp/pico-immersive-phase1/cp0-samples/extracted/welcomespace-0.13.3/welcomespace-0.13.3`

- The initial MCP Gradle build failed only for missing Android SDK configuration. The exact error
  was fed to `pico_fix`; `validate_toolchain` confirmed the SDK roots/JDK, and an external-only
  `local.properties` supplied `sdk.dir`.
- The rerun succeeded in 1m54s across 63 tasks. APK: 192,603,848 bytes, SHA-256
  `8c5965893802b9bf6aab42ef40b6b68de0474d7e7dbbab5b9bc8cd51c1de628e`. Bundle SHA-256:
  `4495e1f0fc24fda7ccd886ceaefdf167a08984764ea01faa4d27369bb01ade0a`.
- Two fresh launches received five samples each across 60.5/60.6 seconds. Both retained an alive
  PID with zero crash, ANR, or dialog events.
- The first dynamic-entry attempt was confounded by Claimsight concurrently holding Full Space;
  it is not used as positive or negative Welcome evidence. After a clean relaunch, semantic UI
  input selected `enter_room_button`; logcat recorded container id 6, name `room`, type Stage,
  style 3, immersion 100, visible and focused. The process stayed healthy.

Capture register:

| Capture | SHA-256 | Adjudication |
| --- | --- | --- |
| `/private/tmp/pico-render/immersive-phase1/welcomespace-settled-baseline.png` | `01968fca45acfea1b19d74f28318b2a186e847b960459621a3ca01f6bbc74d17` | Looked planar hero/control panel. It was not proof of the room and showed the concurrent Claimsight environment beneath it. |
| `/private/tmp/pico-render/immersive-phase1/welcomespace-world-unconfounded.png` | `2ba01dbbfd88fe8d75380fc295335d16095379d771c15080ae39c915d2468df6` | Looked, but black behind the Decorate Space panel; explicitly inconclusive for the world pixels. |
| `/private/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-mcp/gui-1788172454254.png` | `b142249fad0fe69dc4d519a672ee5218e85e25ac453595a157bcd334ca36383d` | **Vision-verified bounded host-GUI pixels.** 1622×1678, 1,314,514 bytes. The looked frame shows a furnished modern room around the Decorate Space inventory panel, with no visible dialog. |

The positive frame was recorded as `vision_verified` for
`com.pico.spatial.sample.welcomespace`; immutable ledger artifact:
`/Users/sushantsrikrish/.pico-mcp/ledgers/artifacts/b142249fad0fe69dc4d519a672ee5218e85e25ac453595a157bcd334ca36383d.png`.

### Licensing constraints

- Code in all eight archives is Apache-2.0; preserve the license, applicable notices, and change
  markings in a distributed derivative.
- Welcome Space separately declares its textures, models, and audio as CC BY 4.0. Reuse therefore
  needs attribution, a license link, and an indication of modifications.
- Spatial Video's remotely streamed sample media is separately restricted to the sample. It is
  excluded from a reusable derivative absent separate written rights.

## Upstream and PICO-docs sweep

The scoped watch list is defined in
[UPSTREAM_PICO_SOURCES.md](../../UPSTREAM_PICO_SOURCES.md). This was not an exhaustive search of
the approximately 65 repositories visible in the PICO GitHub organization listing.

| Source | Classification and usable-today verdict |
| --- | --- |
| [PICO-Spatial-SDK-Samples](https://github.com/Pico-Developer/PICO-Spatial-SDK-Samples) | Current 6.0 source for the same eight sample families: Welcome Space is the one world; seven are feature samples. Source is downloadable. Six are emulator candidates; Mesh/ML are device-only. No current-source build was run in CP0. |
| [PICO-Intelligent-Plugins](https://github.com/Pico-Developer/PICO-Intelligent-Plugins) | Agent/plugin tooling, not an app or world. Downloadable source; not independently runnable as an immersive experience. |
| [Unity-MCP-Extensions](https://github.com/Pico-Developer/Unity-MCP-Extensions) | Unity MCP package/tooling, not a world. Requires a compatible Unity/PICO project. |
| [SecureMR-Samples](https://github.com/Pico-Developer/SecureMR-Samples) | Native/C++ SecureMR examples, not a self-contained Kotlin immersive world; emulator viability is not established. |
| [pySecureMR](https://github.com/Pico-Developer/pySecureMR) | Python bindings/library, not an Android world. |
| [SpatialML-XR-Utils](https://github.com/Pico-Developer/SpatialML-XR-Utils) | XR/ML utility library, not a standalone app/world. |
| [PICO-Unity-SDK](https://github.com/Pico-Developer/PICO-Unity-SDK) | Unity SDK packages, not a world; requires a consuming Unity project. |
| [PICO-Unity-Project-Templates](https://github.com/Pico-Developer/PICO-Unity-Project-Templates) | Starter templates, including a spatial template, but not authored worlds; each needs Unity/PICO setup before a run claim. |

The official 0.13 sample overview presents these archives as feature-oriented building blocks. The
PICO docs and current sample README reinforce the inventory split: Welcome Space is an interactive
furniture environment, while the others demonstrate animation, physics, media, audio, sensing,
ML, or UI capabilities.

## Polyfork license verdict and minimal proof

Authority: [Polyfork licensing](https://polyfork.dev/licensing). Exact 22-word grant:

> Use any asset you download here in personal and commercial projects: games, apps, websites, prototypes, videos, client work and products you sell.

The adjacent terms permit modification and do not require attribution, but prohibit re-upload or
redistribution of original or modified asset files. Licences are per person/team seat. Result:

| Delivery surface | Verdict |
| --- | --- |
| Generated APK/app embedding | Permitted by the express game/app grant when the product does not expose the model as a reusable or separately downloadable asset. Release review remains prudent. |
| Public repo containing Polyfork MJS or GLB | **Do not commit.** The redistribution restriction covers original and modified asset files. |
| Public repo containing the composed GLB or derived PICO bundle | **Do not commit without explicit permission.** The GLB is modified; the extractable derived bundle remains unclear under the same restriction. |
| Repo-owned orchestration/receipts without asset bytes | Permitted for this evaluation when they do not reproduce or expose Polyfork source/geometry. |

All source and derived bytes therefore remain at `/tmp/pico-immersive-phase1/polyfork/`.

The minimal proof uses the free Spaceship Wars kit's Nav Beacon program four times with validated
typed controls. It places four distinct color/geometry variants at `[0,0,1]`, `[4.5,0,-6]`,
`[-4.5,0,-14]`, and `[0,0,-22]`, then adds a 16×28 m floor, a 1.2 m-wide three-segment route,
boundary rails, and posts. The single composed GLB has 24 meshes, 2,474 triangles, four named
landmarks, four distinct palette fingerprints, and transform-aware bounds
`[-8.07,-0.12,-25.07]` to `[8.07,3.2855,3.07]` metres. Two clean generations were byte-identical.

External proof artifacts:

| Artifact | SHA-256 |
| --- | --- |
| License capture `/tmp/pico-immersive-phase1/polyfork/sources/polyfork-licensing.json` | `1adcf6b0ac6d2fcf3955772f3810864aaf3858b03847837f7eaa45a65fb91dd1` |
| Typed Nav Beacon module `/tmp/pico-immersive-phase1/polyfork/artifacts/nav-beacon-1211c9.mjs` | `6bd8f3c5fba4631d78066f9a7b746fd645e15ff8b5a65d20b27f6b8630e5e1bc` |
| Placement/knob manifest `/tmp/pico-immersive-phase1/polyfork/world/placement-knob-manifest.json` | `262453e43e8dc23635bd7b1541749e9becc30ed95ce49d3bd572085da818131d` |
| Composed world `/tmp/pico-immersive-phase1/polyfork/world/spaceship-wars-route-world.glb` | `3ce084128ddbcad65f6f59b5c43434c718dd0eb0c4d35255ac5c4eb49574b764` |
| Derived bundle `/tmp/pico-immersive-phase1/polyfork/pico/spaceship-wars-route-world.bundle` | `87db7bd1ef2ac9acab7c2b3af4f04af9f3e8b964f9b529d846e92bc1cdf26dee` |
| MCP bake/inspect summary `/tmp/pico-immersive-phase1/polyfork/receipts/mcp-bake-summary.json` | `17efb2003a496244a08f5e99bf514f48b1e8b30783f369276687445c4e120d82` |
| Full MCP receipt `/tmp/pico-immersive-phase1/polyfork/receipts/mcp-bake-and-inspect.json` | `b833f84ab1098e7cc9567b8570779c41965d38fbba6489be49131c37c4fc40e3` |

After a fresh repository build, an external MCP client invoked `bake_textured_model`,
`inspect_bundle`, and `decode_spatial_bundle`. The 6.0 bundle contains 25 assets: 15 meshes, nine
vertex-color-enabled material instances, and one scene. It has no texture or collision assets.
This is structural ingestion evidence only: packaging into an APK, runtime loading, rendering,
performance, collision, and visual fidelity are not established.

### Ingestion-lane comparison

| Lane | Measured result | Agent suitability |
| --- | --- | --- |
| USDZ → Spatial Editor | Installed 6.0 package/tool help advertises USDZ input, but Polyfork requires an account for the actual free-asset USDZ. No credential was supplied, no protected export was requested, and no Editor import occurred. | **Artifact-blocked and only structurally advertised.** It cannot complete an unattended proof today and adds an interactive authoring dependency. |
| Composed GLB → MCP bake → SDK bundle load | Exercised headlessly through the real MCP. Typed controls, placements, deterministic hashes, material/mesh inventory, and runtime handoff are inspectable. | **Preferred for the minimal agent-driven proof in an external/private asset workspace.** It is deterministic and automatable, but still needs authorized app embedding plus a LOOK before any render claim. |

The repository asset gate's primitive-accessor bounds do not apply node transforms, so its reported
bounds are not authoritative world-space dimensions for this composition. The transform-aware
composer bounds above are the placement authority for CP0.

## CP0 evidence ceilings and remaining work

- Claimsight and the Welcome Space host-GUI frame have `vision_verified` bounded pixel claims.
- The Polyfork composition and bundle are `structural`; no app launch or rendered-frame claim is
  made. The bundle contains no collision assets.
- No CP0 run characterized a Guardian boundary, ejection, or recovery. U1, U2, U4–U9, U11, U12,
  U16, U18, and U19 therefore remain open after this checkpoint.
- No result transfers to physical hardware. U3, U13, and U14 remain open, and the physical device
  was never touched.
- CP0 added no MCP tool, changed no surface count, added no npm script key, and made no version
  change.

## CP0 gates

Run from the branch worktree after a fresh `npm run build`:

| Gate | Result |
| --- | --- |
| TypeScript build | PASS |
| `test/docsmeta.mjs` | PASS, 0 failures; all 119 relative links across 53 files resolved |
| `test/adoption-safety.mjs` | PASS, 48 checks / 0 failures |
| `test/distribution-adoption.mjs` | Expected baseline only: 41 pass / 2 known failures. The failures remain the stale 44-vs-45 Linux lane count and 46-vs-48 test-suite count. No additional failure occurred. |
| `benchmarks/**` and `test/agentbench-*` | Byte-unchanged from `8b0ed19` |
| Version and npm scripts | `package.json` byte-unchanged from `8b0ed19`; version remains 37.0.0 and no script key changed |

No tarball was required for CP0 because the tool/surface counts did not change.
