# CP3 staged immersive boundary experiment

Date: 2026-09-01

Branch: `immersive-phase1-2026-08-31`

Target: `emulator-5554` only

PICO OS: 6.0.0; emulator package 0.13.1

Physical serial `2G0YC5ZF7Z056Q`: never selected or touched

This is the Phase-1C checkpoint from the
[immersive boundary and navigation plan](../../superpowers/plans/2026-08-29-immersive-boundary-and-navigation.md).
It runs the CP2 matrix through staged prepare → one movement group → LOOK → adjudicate → ordered
recovery, replays the canonical M0 action script without controller-side synthesis, and retains all
heavy evidence outside the repository.

## Outcome

One current emulator configuration produced a real, LOOKed boundary symptom, but it did **not**
complete the planned dynamic-vs-manifest comparison:

| Row | Canonical result | Looked distance bracket | Recovery |
| --- | --- | --- | --- |
| M0, manifest Mixed | PASS, `retained_immersive_through_route` | App geometry retained through the authored and readable 32 m forward gate. | Not invoked; the route passed. |
| F1, manifest Full | FAIL, `ejected_to_system_home` | App visible at the authored 1 m gate; system home at the waypoint targeting 2 m. This is a route-gate bracket, not calibrated physical distance. | Observe, ordinary activity launch, and force-stop/relaunch all left system-home pixels; `recovery_inconclusive`. |
| F2, dynamic Full from a Mixed root | `preparation_failed` / `binding_lost` | No movement. The authenticated open returned, but the settled frame showed system home and the resumed component changed to an unlisted same-package SDK stub. | Not eligible because preparation failed. |
| E1, Claimsight Editor-authored manifest Full | FAIL, `ejected_to_system_home` | Claimsight retained after replay action W444 and system home appeared after W889. Its canonical `witnessedGateM` is 0 because Claimsight has no Boundary Lab metric witness. | Same three fallbacks left system-home pixels; `recovery_inconclusive`. |

The narrow configuration-scoped conclusion is therefore: M0 Mixed retained, while two independent
manifest-Full apps yielded to the PICO system home by their second replay waypoint. F2 did not reach
a looked dynamic-Full baseline or movement. These results weigh against a **dynamic-entry-only**
explanation and keep Full-versus-Mixed style as a live confound. They neither confirm nor refute
the partner's same-world stage-style-1 workaround, isolate a cause, establish physical metres, or
say anything about hardware Guardian/Safeguard.

## Implementation commits and paths

| Commit | Live-run-relevant result |
| --- | --- |
| `490fc07` | Adds the full-only staged `run_immersive_boundary_experiment` tool, immutable run storage, M0 replay binding, route adjudication, and ordered recovery. |
| `86ce630` | Makes the bounded outer-gate route reachable without weakening aggregate budgets. |
| `4e2c917` | Revalidates receipt-bound canonical AppSpec snapshots. |
| `ba4c42f` | Clears only owned installed immersive incumbents before the system-home reference. |
| `28dfd1a` | Separates gRPC camera motion from host-window focus. |
| `4619b6d`, `2706f2a`, `6661d16`, `74729ab` | Preserve and re-review stable preflight drift, every rebaseline attempt, retry health evidence, and settled preparation frames. |
| `b97ccb9` | Waits for rendered movement completion before settlement. |
| `4db83eb` | Drains concurrent identity probes, scans the complete 64 MiB-bounded health artifact, caps retained candidates at 4,096, and fails closed on overflow. |

Primary code and owning tests are `src/boundaryexperiment.ts`, `src/navigation.ts`,
`src/cameradrive.ts`, `src/observation.ts`, `src/runtimecontinuity.ts`,
`src/runreceiptstore.ts`, `test/boundaryexperiment.mjs`, `test/navigation.mjs`,
`test/observation.mjs`, `test/runtimecontinuity.mjs`, and `test/runreceipt-store.mjs`.
`src/index.ts` registers the new tool only on the full surface.

## Canonical binding and cold-launch monitors

M0 authored one immutable route. F1, F2, and E1 bind their run manifests to all three M0 source
facts: route SHA-256
`5907cc62b421e97b4f0bef1705269a4f6d70f1e1c7a0f1b0bd7f640e16a8fa21`, source run manifest
`d335e3b71384784fa20fe9a5a522dd601b8aaecb9ed10c6b4c99c6b94d40c05a`, and source adjudication
`3039f2959139b9e6b0ecf3c53d71daf3db3db53c247b8dc88c8d8c33df185e2c`.
The normalized replay has six waypoints and action groups targeting authored 1, 2, 4, 8, 16, and
32 m gates. Holds longer than 5,000 ms are segmented, which is why the complete M0 route used nine
bounded actions.

Each canonical fresh launch received a monitor for at least 60 seconds. Five checks at offsets
0/15/30/45/60 reported no crash or ANR, and the 0/30/60 GUI frames were LOOKed. F2's custom monitor
ran after fail-closed preparation and therefore establishes only that its system-home state had no
dialog; it is not an app-health claim.

| Row | Boot, PID/start | Monitor result | Record and image evidence |
| --- | --- | --- | --- |
| M0 | `8a778037-3434-4137-a31a-cb4156ff38e7`, 3384/9112 | PASS, 63.662 s | `/private/tmp/pico-immersive-phase1/cp3/dialog-monitors/m0-prepare-017/dialog-monitor.json`, SHA `d8cedd6d809242a37b2d9c4a5d9a124241e8e9997d7f4d06e32ee18f7f5d0348`; GUI `02`, `07`, `12` each SHA `b3e46e72cd939dd42491742ae88ac005f999906063611bebc7d44d4970264836`; `settled-60.png` SHA `3dde24ba8ccdaa677a72c058d3df400b36ede059eefb90ccd111e71c4cb43771`. |
| F1 | `68d79ca6-c48a-40cf-832d-ecb03903f2e9`, 4677/67010 | PASS, 61.830 s | `/private/tmp/pico-immersive-phase1/cp3/dialog-monitors/f1-prepare-003/dialog-monitor.json`, SHA `0cfad5b9b6e4a312c82051d5af78222c2a858a35cf2c0a0d67f90b2ecb032d1e`; GUI `02`, `07`, `12` each SHA `99fd1d3abc10795f4b583fd0f1fec5c672e862ee2a3c79bd2552f9cbd8195f1d`; `settled-60.png` SHA `4e135c1b4543d60d2283aa4b998ca32d2bdd92925ab77257291a7578c8348585`. |
| F2 | `1d46804e-e5fd-44e5-b903-db6da50ad571`, 5934/16054 before component rejection | PASS as a 63.702 s no-dialog observation; not an app launch pass | `/private/tmp/pico-immersive-phase1/cp3/dialog-monitors/f2-prepare-failed-001/dialog-monitor.json`, SHA `cd2c0fb45949456e6a0ba2627ac6b48a7957277d874eb548cf09fc810eca80c5`; full `settled-0/30/60.png` each SHA `d2e91711bb99490f21e63c5eea48acaa5782fb1f98a0a59416f250156be1f1eb`; corresponding retained small captures each SHA `1115f2d3cc677e70aa254111650b9be5f044204dfa114721e4a173a85dc54b5d`. |
| E1 | `cb799c61-993d-40ab-b609-bffbbc738f99`, 3490/13663 | PASS, 64.135 s | `/private/tmp/pico-immersive-phase1/cp3/dialog-monitors/e1-prepare-002/dialog-monitor.json`, SHA `1c28bae2144cde9bc8786ec03a16001aef85e5f59daf09f85cc2b9023237a8e6`; GUI `02`, `07`, `12` each SHA `6200e43617eb8b4d44a7be801703a5d4f60a91ec48e633908ccbc1d805f6e90e`; `settled-60.png` SHA `6c2375d72649ef55b6841a38a055eba64a7d9972ef953a236bec3a478c4db967`. |

All monitor images above were individually LOOKed. None showed an ANR/crash/system dialog. Equal
hashes are reported explicitly rather than treated as separate visual observations.

## Complete canonical route-frame register

The staged tool never assigns visual meaning. Each attestation below was made only after LOOKing at
the retained PNG. Route adjudication caps these records at `vision_verified_eligible`; it does not
write or silently promote a trust-ledger class.

### M0 — manifest Mixed

Run ID: `f271d4adcf4fc3133837e27cecc94e5cccb93618dd5c32659f8647e505bd6d65`

Run root: `/private/tmp/pico-immersive-phase1/cp3/runs/m0-forward-017`

| Frame | Absolute path | SHA-256 | LOOK result |
| --- | --- | --- | --- |
| Home reference | `/private/tmp/pico-immersive-phase1/cp3/runs/m0-forward-017/captures/000-home-reference.png` | `038cb2041b04a6f4838941fbf631cd2d60b382552271caf5c0d3e99871be37f6` | Bedroom Day system home; no Boundary Lab geometry. |
| App baseline | `/private/tmp/pico-immersive-phase1/cp3/runs/m0-forward-017/captures/010-app-baseline.png` | `4c77e54b3ea5b8f1d6c6c0a37b95af75d5a4d7bc676fb7f13ae019c36639cb87` | `MANIFEST MIXED ROOT`, cyan gates, magenta/cyan grid, and Bedroom Day are visible. |
| No-input rebaseline transition | `/private/tmp/pico-immersive-phase1/cp3/runs/m0-forward-017/captures/101-waypoint-1-transition.png` | `3dde24ba8ccdaa677a72c058d3df400b36ede059eefb90ccd111e71c4cb43771` | Same M0 scene retained; no movement or ejection. |
| Authored 1 m gate | `/private/tmp/pico-immersive-phase1/cp3/runs/m0-forward-017/captures/101-waypoint-1-attempt-2.png` | `102d31de10f1d4f94aaf5a646041ea91ec889f83607974ca7c5bdfda81bcbc12` | First cyan gate envelops the view; M0 and Bedroom Day remain. |
| Authored 2 m gate | `/private/tmp/pico-immersive-phase1/cp3/runs/m0-forward-017/captures/102-waypoint-2.png` | `d55c53bf5fcf3684ef4e3d246b54470db40481656bbaaf4ebba5a7d7c08acadf` | Root/envelope labels and next 4 m gate remain visible. |
| Authored 4 m gate | `/private/tmp/pico-immersive-phase1/cp3/runs/m0-forward-017/captures/103-waypoint-3.png` | `486a60ea801c5175337ba24496921be120e39c9e39fc447acd248fa31e15da27` | Cyan corridor, grid, and Bedroom Day remain. |
| Authored 8 m gate | `/private/tmp/pico-immersive-phase1/cp3/runs/m0-forward-017/captures/104-waypoint-4.png` | `68e556da3cd939e529422049773db0ac1ac51d3597bc39888693b3128497ce2c` | App gate train and enclosure remain against the blue exterior field. |
| Authored 16 m gate | `/private/tmp/pico-immersive-phase1/cp3/runs/m0-forward-017/captures/105-waypoint-5.png` | `cd0e4652a4e0c6ba07019a273b63676e98db6b4a4552657f8d720671d04030ca` | Outer cyan gate and enclosure remain; no home UI or app disappearance. |
| Authored 32 m terminal gate | `/private/tmp/pico-immersive-phase1/cp3/runs/m0-forward-017/captures/106-waypoint-6.png` | `4b53078e63592ba7d10fbb90259791d2b74ec251137c6bb6c9187cfd50ee33e4` | The 32 m gate envelops the view and its label is readable; app geometry remains. |

M0 used 9 actions, 6 waypoints, 26,666 ms key hold, and 122,999 ms total route time. All
21 continuity samples retained boot/PID/start/APK and `exact_allowed` foreground. Fifteen health
windows reported no attributed failure. Watchdog candidates were retained but all 21 samples were
`unparsed`, so they add no parsed watchdog claim.

### F1 — manifest Full

Run ID: `55ba83334dcd1a684b14448da0ef7fea0d0287eabd4ea57cf7fea0db47bad718`

Run root: `/private/tmp/pico-immersive-phase1/cp3/runs/f1-forward-003`

| Frame | Absolute path | SHA-256 | LOOK result |
| --- | --- | --- | --- |
| Home reference | `/private/tmp/pico-immersive-phase1/cp3/runs/f1-forward-003/captures/000-home-reference.png` | `d2e91711bb99490f21e63c5eea48acaa5782fb1f98a0a59416f250156be1f1eb` | PICO bedroom system home; no app geometry. |
| App baseline | `/private/tmp/pico-immersive-phase1/cp3/runs/f1-forward-003/captures/010-app-baseline.png` | `8a4057363c1fef251dd294f3581c03aacc458be0ce5e1fb15ed08845e4c9c6aa` | `MANIFEST FULL`, cyan gates, and grid on an opaque black Full background. |
| No-input rebaseline transition | `/private/tmp/pico-immersive-phase1/cp3/runs/f1-forward-003/captures/101-waypoint-1-transition.png` | `4e135c1b4543d60d2283aa4b998ca32d2bdd92925ab77257291a7578c8348585` | Same Full scene retained; no system home. |
| Authored 1 m gate | `/private/tmp/pico-immersive-phase1/cp3/runs/f1-forward-003/captures/101-waypoint-1-attempt-2.png` | `17302c3307090499300bf3bc5da6235a689d8226bb662156ebad74df3e39a129` | First gate envelops the view; `MANIFEST FULL` and enclosure remain. |
| Waypoint targeting authored 2 m | `/private/tmp/pico-immersive-phase1/cp3/runs/f1-forward-003/captures/102-waypoint-2.png` | `db4501e3d93f3f413faf97ede4a4f63dd3f0fd4406cf6d4e69635218a644121c` | PICO bedroom system home; no F1 label, gate, grid, or black Full background. |

F1 used 2 actions, 2 waypoints, 1,333 ms key hold, and 30,319 ms route time. Fourteen of
15 continuity samples retained exact PID 4677/start 67010/boot/APK/component; the only different
package/no-PID sample followed the final force-stop. Thirteen health windows reported no attributed
failure. One initial watchdog sample parsed as advancing and 14 were `unparsed`. The pixel ejection
therefore occurred without a recorded route-time process restart, allowed-component loss, or
attributed crash/ANR.

### F2 — dynamic Full preparation failure

Run ID: `993ccbc5ed1925f31f9b4605807b0cbc2ba7d366b1fc990ec5c118d7c5146633`

Run root: `/private/tmp/pico-immersive-phase1/cp3/runs/f2-forward-001`

| Frame | Absolute path | SHA-256 | LOOK result |
| --- | --- | --- | --- |
| Home reference | `/private/tmp/pico-immersive-phase1/cp3/runs/f2-forward-001/captures/000-home-reference.png` | `54e98417eef3fa7309489bfab5d65919de355cc89a101106472063afe4d3f439` | System home; no Boundary Lab geometry. |
| Settled post-open candidate | `/private/tmp/pico-immersive-phase1/cp3/runs/f2-forward-001/captures/010-app-baseline.png` | `d2e91711bb99490f21e63c5eea48acaa5782fb1f98a0a59416f250156be1f1eb` | PICO bedroom system home; no `DYNAMIC FULL` sentinel or enclosure. |

The exact app PID/start/boot/APK emitted authenticated
`command_received → stage_open_requested(Full) → stage_open_returned`, followed by dynamic owner
create/start/resume events. The resumed component nevertheless changed from the allowlisted
`com.fleet.boundarylabdynamicfull/.platform.LaunchActivity` to same-package
`com.pico.spatial.ui.platform.stub.SpatialStubActivity`. The tool therefore stopped with
`preparation_failed` / `binding_lost` before movement, adjudication, or recovery. The raw health
artifact was complete and had no attributed failure. This is structural evidence that an open was
requested and returned, not visual proof that an active secondary Full Stage rendered.

### E1 — Claimsight Editor-authored manifest Full

Run ID: `3f56516065f789fa27a4667e3afd2471fbe017a7c45758c87e7ca94fcac01e77`

Run root: `/private/tmp/pico-immersive-phase1/cp3/runs/e1-forward-002`

| Frame | Absolute path | SHA-256 | LOOK result |
| --- | --- | --- | --- |
| Home reference | `/private/tmp/pico-immersive-phase1/cp3/runs/e1-forward-002/captures/000-home-reference.png` | `eaaac18dcbdb726ae813b8419e3bb43fe1b801f4b8a519e9522771d3034019be` | PICO bedroom system home; no Claimsight landmark. |
| App baseline | `/private/tmp/pico-immersive-phase1/cp3/runs/e1-forward-002/captures/010-app-baseline.png` | `6c2375d72649ef55b6841a38a055eba64a7d9972ef953a236bec3a478c4db967` | Readable translucent Full Stage card, blue outlined cube, sky/cloud enclosure. |
| Replay action W444 | `/private/tmp/pico-immersive-phase1/cp3/runs/e1-forward-002/captures/101-waypoint-1.png` | `cd25fdcf9868811e45818bdb2399cd8e81cc84117d7f6fa231b88c89c6f06fd1` | Claimsight retained; card, enlarged cube, sky, and clouds remain. |
| Replay action W889 | `/private/tmp/pico-immersive-phase1/cp3/runs/e1-forward-002/captures/102-waypoint-2.png` | `b72f17b28651982b03dfa6922a1f5c90c024042f07fc95b62520baf302a605f7` | Bare PICO bedroom system home; no Claimsight landmarks. |

E1 used 2 actions, 2 waypoints, 1,333 ms hold, and 39,004 ms route time. Twelve of 13 continuity
samples retained exact PID 3490/start 13663/boot/APK/component; the only different-package/no-PID
sample followed force-stop. All 11 health windows were complete and reported no attributed
failure, ambiguity, or other-package incident. Watchdog parsing stayed `unparsed`; focus remained
Claimsight and raw `lastRenderTime` advanced before force-stop. No route-time lifecycle loss was
attributed. The canonical metric witness remains 0 even though the replay actions are byte-bound to
M0: Claimsight does not contain Boundary Lab's authored distance gates.

## Ordered recovery and every retained recovery frame

F1 and E1 both executed the required observe → ordinary activity launch → force-stop/relaunch
sequence. Every before/after frame below was separately LOOKed; equal bytes did not bypass LOOK.

| Row and fallback | Absolute paths | SHA-256 | Structural and visual result |
| --- | --- | --- | --- |
| F1 observe | `/private/tmp/pico-immersive-phase1/cp3/runs/f1-forward-003/captures/960-observe-before.png`; `/private/tmp/pico-immersive-phase1/cp3/runs/f1-forward-003/captures/960-observe-after.png` | both `db4501e3d93f3f413faf97ede4a4f63dd3f0fd4406cf6d4e69635218a644121c` | Exact app binding remained, but pixels stayed at system home. |
| F1 activity launch | `/private/tmp/pico-immersive-phase1/cp3/runs/f1-forward-003/captures/970-activity_launch-before.png`; `/private/tmp/pico-immersive-phase1/cp3/runs/f1-forward-003/captures/970-activity_launch-after.png` | both `db4501e3d93f3f413faf97ede4a4f63dd3f0fd4406cf6d4e69635218a644121c` | Launch was ignored with the same PID/start; pixels stayed home. |
| F1 force-stop/relaunch | `/private/tmp/pico-immersive-phase1/cp3/runs/f1-forward-003/captures/980-force_stop_relaunch-before.png`; `/private/tmp/pico-immersive-phase1/cp3/runs/f1-forward-003/captures/980-force_stop_relaunch-after.png` | both `db4501e3d93f3f413faf97ede4a4f63dd3f0fd4406cf6d4e69635218a644121c` | Force-stop removed the PID; no replacement PID started; pixels stayed home. |
| E1 observe | `/private/tmp/pico-immersive-phase1/cp3/runs/e1-forward-002/captures/960-observe-before.png`; `/private/tmp/pico-immersive-phase1/cp3/runs/e1-forward-002/captures/960-observe-after.png` | both `b72f17b28651982b03dfa6922a1f5c90c024042f07fc95b62520baf302a605f7` | Exact app binding remained, but pixels stayed at system home. |
| E1 activity launch | `/private/tmp/pico-immersive-phase1/cp3/runs/e1-forward-002/captures/970-activity_launch-before.png`; `/private/tmp/pico-immersive-phase1/cp3/runs/e1-forward-002/captures/970-activity_launch-after.png` | both `b72f17b28651982b03dfa6922a1f5c90c024042f07fc95b62520baf302a605f7` | Launch was ignored with the same PID/start; pixels stayed home. |
| E1 force-stop/relaunch | `/private/tmp/pico-immersive-phase1/cp3/runs/e1-forward-002/captures/980-force_stop_relaunch-before.png`; `/private/tmp/pico-immersive-phase1/cp3/runs/e1-forward-002/captures/980-force_stop_relaunch-after.png` | both `b72f17b28651982b03dfa6922a1f5c90c024042f07fc95b62520baf302a605f7` | Force-stop removed the PID; no replacement PID started; pixels stayed home. |

The canonical recovery manifests are F1
`7a45ba68aae5585f003c038edef9cc2b2ef70494cf2b4ae751bb72869242e318` with adjudication
`0bddcfbded2a4d4d240f601d0bbbe3574908703d060e700bbce02048beaaa4d6`, and E1
`05a1d9811cf37dabbcb123c29af170d0de1ab5db92e747af201daf2dbb0b5aaa` with adjudication
`c39d37dc1e17d81575bfb3306efce70053d254c960715d5eccbe4d8f68cbe37b`.
Both final results are `recovery_inconclusive`, not “recovery failed”: the last operation could not
establish a replacement app identity.

## Immutable manifests and external-tree digests

| Row | Canonical run / route / adjudication SHA-256 | Run tree | Driver tree | Monitor tree |
| --- | --- | --- | --- | --- |
| M0 | `d335e3b71384784fa20fe9a5a522dd601b8aaecb9ed10c6b4c99c6b94d40c05a` / `5907cc62b421e97b4f0bef1705269a4f6d70f1e1c7a0f1b0bd7f640e16a8fa21` / `3039f2959139b9e6b0ecf3c53d71daf3db3db53c247b8dc88c8d8c33df185e2c` | 34 files, 181,193,765 bytes, `dd84c0f1b2c7e4b295cd75df9891e2b88ebc55d4d616cffda0e918255f1ea115` | 32 files, 22,248,092 bytes, `d1a23763b5e0f2c04fd3851f64d74f27d7f599b948b516e482f8ad5829302e85` | 9 files, 14,885,649 bytes, `6224d25a5353dbd6f09a7ae57f326d5dd99a281109c5db2bc9100db1edd166b7` |
| F1 | `4c4c6b1ba167e371e72bfd7ee0ef0bebacc9b6060eb1c1ebfbfa84434cadd8c8` / `d21fb9cc018ad8ea1e544ab1c62cb4d48606d4646c1637c69f7191e51a437bb4` / `2f542cd71a5719c4528130b01ef9e58c81833d82c3cad6a6725f050596da8bd9` | 33 files, 127,849,398 bytes, `1e20df432f3b53ba04e64ed2ac44ad4baae5602a28527e730388b7acd05abdf4` | 35 files, 22,866,337 bytes, `d7cc4db2a6bdcded633f9da27ed544f1afd027bd232fe6416807b2dde774be70` | 9 files, 1,504,446 bytes, `60478648ea1341d71d9c3c13c3e33d1c9f79a09e185b1f1fad1cc494a76e2775` |
| F2 | `c0e95eb1129294dd492c1212a24fa6b0c3287da7c748b719256244a7a8e71df4` / `139c4540797131ace3ef1489436f0dc20831fd0e5daa79c8f88f81f9a59e1abd` / none | 13 files, 10,748,879 bytes, `8be175ba71b51abaf613d8aa0e5875443df53be7286b37a0f24bf4dcba8aa773` | 5 files, 8,156,210 bytes, `4b8e407a1a9aad2b241dcb9d0c181dd6878f3afeb69bbdae84009168a3d93207` | 12 files, 23,178,132 bytes, `f713a71486b2344ef1508125b59f482f3ac29e0f0da9a6f87eeb67e579b4f647` |
| E1 | `93db4ed5281838fff11e9e6a209f982cdfb4a1ca0c2c992ae6e9e51bb871f556` / `bc0bd6e8681e0378fbe5ba01ff7b76c0121abad2963625bc87b4f10043e57faf` / `e5c04f67c7510e422ea0d8e4e0755304caa83dd947d9a1fb845822b1c09b3ed6` | 30 files, 62,119,750 bytes, `8f870c63f242143e6f85e6ba1c48048152b267e5cf1fb548c4176a78e78d4e1f` | 30 files, 24,195,680 bytes, `cb9e17f98b9268ef0b5b5e4415a44d9e390fd02c596e7dbdbc4503703bf7dfd1` | 9 files, 6,404,110 bytes, `d603be77c1c2d8f31f78321d7353360ae1efa747300e52024aa64f7a2d13a12d` |

Tree digest algorithm: bytewise-sort by relative POSIX path; serialize each regular file as
`path<TAB>bytes<TAB>file-sha256<LF>`; hash the UTF-8 manifest. No target file was open during the
final digest pass.

## Preserved noncanonical attempts and live corrections

The external CP3 tree intentionally retains diagnostic/noncanonical attempts; none is substituted
for the four results above.

- M0 required several harness corrections before run 017. These exposed bounded-budget reachability,
  host focus versus gRPC focus, render-completion timing, and a one-shot stable-frame rebaseline.
  Each correction was test-driven and committed separately; run 017 is the only M0 source route.
- The first E1 run is preserved at
  `/private/tmp/pico-immersive-phase1/cp3/runs/e1-forward-001`. It performed zero movement and was
  structurally adjudicated `binding_lost` because a complete 10,547,800-byte preflight artifact had
  82,683 split lines, 75,712 after its unique marker, while the scanner incorrectly treated more
  than 65,536 lines as collector incompleteness. Full bytes contained no attributed or ambiguous
  failure. The repair scans the already hash/stat/64 MiB-bounded artifact in full while bounding
  retained crash candidates; canonical run 002 then completed. Run-001 manifest SHA is
  `9ddca58bccd144244a33ff538cdfa2b5144136849e3b5fb5fbca269d9435ab51`.
- A bounded qemu identity rejection exposed a Node strict-unhandled-rejection/owned-child race.
  The final helper starts all four probes together, drains all settlements, and only then propagates
  the deterministic first input-ordered error. Its strict regression also requires zero probes in
  flight when the helper settles.
- The first F1 terminal review and one recovery adjudication were semantic errors, not evidence;
  exact retries preserved every already accepted frame attestation. E1's first route adjudication
  likewise omitted prior `witnessedGateM:0` fields and was rejected before an exact retry.
- The exact F2 preparation error, E1 scanner error, and rejected-adjudication errors were sent
  verbatim to `pico_fix`; no existing lesson matched. No schema was widened to make F2 pass.

These are implementation corrections inside the plan's fail-closed contracts, not material design
deviations. The only unexecuted planned comparison is F2 movement: admitting the SDK stub or
claiming the home-looking frame as dynamic Full would have materially weakened the design, so that
lane stopped and is reported honestly.

## UNVERIFIED register after CP3

This republishes every plan item with the exact scope of the new observation. Closing or narrowing
one row does not close a broader row.

| ID | Status after CP3 | Evidence and remaining closure |
| --- | --- | --- |
| U1 | **Narrowed; positive local symptom, formal plan closure unmet.** | LOOKed F1 and E1 runs yielded to system home. The stipulated looked F2 terminal trace did not occur, so the intended dynamic-row closure remains open. |
| U2 | **Open; evidence weighs against dynamic-entry-only causation.** | M0 manifest Mixed retained through 32 m; F1 manifest Full yielded by the 2 m target; E1 editor-manifest Full yielded on the second replay action; F2 never moved. Repeated equal-gate M0/F1/F2 runs are still required. |
| U3 | **Open.** | No Swan or other physical-device run occurred. Emulator findings do not establish PICO's hardware fix status or Guardian/Safeguard behavior. |
| U4 | **Open.** | Authored metre gates make route brackets visible, but emulator hold milliseconds remain uncalibrated to physical metres. |
| U5 | **Narrowed for forward M0.** | Baseline plus 1/2/4/8/16/32 m forward gates were LOOKed and the terminal label was readable. Backward/left/right route legibility remains unmeasured. |
| U6 | **Narrowed, still open.** | Marker-bound raw `logcat -b all` artifacts and tag inventories were retained. No exact Guardian/boundary tag was identified, so no narrow boundary-tag or root-cause claim is made. |
| U7 | **Answered for the two exact ejections; generalized row open.** | F1/E1 pixels changed to home while their app PID/start/APK/allowed component stayed coherent and no attributed pause/process failure was found. Only the later forced stop removed the PID. Repeat runs and hardware remain open. |
| U8 | **Narrowed, still open.** | Watchdog raw focus/render-time fields were retained; most samples were `unparsed` and only one F1 sample parsed advancing. Field meaning and controlled stalled/advancing comparison remain unverified. |
| U9 | **Narrowed, still open.** | Non-black, LOOKed adb-settled pixels clearly distinguish app landmarks from PICO bedroom home, while host-window frames cover launch/baseline. No same-moment host-versus-adb terminal pair was captured, so the plan's alternate-capture closure remains unmet. |
| U10a | **Closed for exact Claimsight bytes.** | CP0's clean rebuild binds source, receipt, APK path, size, and SHA `7ecce31e…8bbf`. |
| U10b | **Closed for exact Claimsight install/runtime/baseline.** | CP0 and E1 bind install, package/PID, launch monitor, and the looked card/cube/cloud landmark baseline. |
| U11 | **Open, structurally narrowed.** | F2 emitted authenticated request/open-return and dynamic owner lifecycle events, but no looked `DYNAMIC FULL` baseline or route trace followed. |
| U12 | **Answered for exact F1/E1 runs; generalized guidance open.** | Passive observation and ordinary relaunch did not restore pixels; force-stop removed the process but produced no replacement. Both ordered runs ended `recovery_inconclusive`. |
| U13 | **Open.** | No hardware/live-passthrough byte-exact settle measurement occurred. |
| U14 | **Open.** | No wearer-guided Guardian route or hardware distance comparison occurred. |
| U15 | **Open.** | No automatic system-home classifier was added; every pixel verdict came from LOOK. |
| U16 | **Open.** | Clock correlation and bounded samples improve ordering, but action, log, lifecycle, watchdog, and capture are still independent observations rather than one atomic same-frame event. |
| U17 | **Closed only to the CP0/E1 version-qualified extent.** | Spatial Tools 0.13.1 / `spatialToolsVersion=0.13` Claimsight installed and rendered on the selected 6.0 emulator, then completed an adjudicated two-waypoint replay attempt. A receipt-bound matched 6.0 Editor rebuild remains open. |
| U18 | **Open.** | F2 self-report says Full open returned, but LOOK showed system home and exact component binding was lost. Active secondary Full is not visually verified. |
| U19 | **Negatively observed once, configuration-scoped.** | After accepted dynamic open, resumed ownership changed from `LaunchActivity` to same-package `com.pico.spatial.ui.platform.stub.SpatialStubActivity` while APK/PID/start/boot stayed stable. One run does not justify a generalized allowed-component policy. |

## Tool surface, protected files, and gates

- CP3 adds exactly one full-only MCP tool: `run_immersive_boundary_experiment`. Doors remains 18.
  The full surface is 253 tools on macOS (installed-tarball runtime-measured) versus a source-derived
  250 on Linux and Windows from the three-tool host-GUI registration delta. The count chain includes
  the tracked `.claude/rules/release-invariants.md`, verifier/adoption assertions, metadata stamper,
  and synchronized docs/manifests.
- Package version remains 37.0.0. The 53 npm script keys are unchanged. Existing values adopt the
  owning suites: `test:emulator-restart` adds navigation/runtime-continuity tests and
  `test:conformance` adds the boundary-experiment test.
- Heavy captures, APKs, driver responses, logs, run stores, and tree manifests remain outside the
  repository. This directory contains only Markdown summaries; no crop was needed.
- `benchmarks/**` and `test/agentbench-*` are required to remain byte-identical to base `8b0ed19`.

CP3 gate results:

| Gate | Result |
| --- | --- |
| TypeScript build | PASS |
| Boundary/route/continuity owning suites | PASS: conformance/boundary experiment; emulator/navigation/observation/continuity 139 passed, 0 failed, 1 expected Darwin-guarded skip; receipt store 36/0. Focused final repair run was 99/0. |
| `test/docsmeta.mjs` | PASS, 0 failures; metadata synchronized and 125 relative links resolved across 56 files. |
| `test/adoption-safety.mjs` | PASS, 48/0. |
| `test/distribution-adoption.mjs` | Accepted baseline exactly, 41/2. Only “47 named gate invocations…” (actual Linux 45 versus stale 44) and “distribution metadata records…” (actual scripts 48 versus stale 46) failed. |
| Doors surface | PASS, exactly 18; the new full-only tool is absent. |
| Installed tarball | PASS, 0 failures: clean install listed full macOS 253, every anchor including `run_immersive_boundary_experiment`, Doors 18, and env-unset Doors 18. |
| Protected benchmark/agentbench diff | PASS: `git diff --exit-code 8b0ed19 -- benchmarks ':(glob)test/agentbench-*'`. |
