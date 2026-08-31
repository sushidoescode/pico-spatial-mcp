# CP2 matched immersive app matrix

Date: 2026-08-31

Branch: `immersive-phase1-2026-08-31`

Target: `emulator-5554` only  
PICO OS: 6.0.0  
Boot ID: `cbcba1b5-bd2b-485e-ac42-42e3343080aa`  
Physical serial `2G0YC5ZF7Z056Q`: not selected or touched

This is the Phase-1B checkpoint from the
[immersive boundary and navigation plan](../../superpowers/plans/2026-08-29-immersive-boundary-and-navigation.md).
It materializes one canonical Boundary Lab as the matched `M0`/`F1`/`F2` matrix, builds and installs
all three rows through `fleet_build`, LOOKs their receipt-bound baselines, and retains Claimsight as
the Editor-authored `E1`. Heavy captures, generated Android projects, APKs, run receipts, and monitor
logs remain outside the repository.

## Outcome and commits

| Commit | Result |
| --- | --- |
| `c8e0ae9` (`feat(boundary): add matched immersive probe apps`) | Canonical spec, pure matrix materializer, strict AppSpec route discriminator, matched code generation, debug-only authenticated `BoundaryProbe` bridge, and owning tests. |
| `867719d` (`fix(boundary): use SDK-safe enclosure entity names`) | Replaces raw signed/decimal coordinate spellings in entity names with deterministic ordinals after the first live launch exposed the SDK grammar. |

Primary repository paths:

- `briefs/boundarylabmixed.json`
- `src/boundarymatrix.ts`, `src/boundaryprobe.ts`, and `scripts/materialize-boundary-matrix.mjs`
- `src/appspec.ts`, `src/assemble.ts`, and `src/compiler.ts`
- `test/boundaryprobe.mjs` and `test/spatialbench.mjs`

No generated Android project, APK, capture, raw log, or user-store brief was committed.

## Matched materialization and provenance

The normalized shared scene/profile payload hash is
`ebee7e366e80b62c9ae8f44bfc07e8599d38b389b93cd1a0f3f2feff0e3c630e`. The allowlisted variant
differences are package/app identity, manifest stage style, `boundaryLab.variant`, the F2-only
secondary Full Stage, and route-specific sentinel/entry wiring.

| Row | Stable package and launch route | User-store record SHA-256 | Effective AppSpec SHA-256 |
| --- | --- | --- | --- |
| M0 | `com.fleet.boundarylabmixed`; manifest Mixed | `0729b508d934750c6ba94ba75c767b667942d6a8f1e9ee66b43252fe1f9e5d82` | `b6443a1a679845613c2d6b974f7b1546deafbcda600c6ee460109615631c49ca` |
| F1 | `com.fleet.boundarylabmanifestfull`; manifest Full | `4ef68e88f28c5689920fd1c0795aafea6ce6fe9dfaa8bd60a87cd79fe073fbe4` | `8cd9f0e6b2f5233e224e2d62c1ac706f5a8d7bf6ffc321a2017945cbeed46825` |
| F2 | `com.fleet.boundarylabdynamicfull`; manifest Mixed root plus one direct-open secondary Full Stage | `8d66afc5dd0aca60a1dc9f9d3f2aca11dbdecde735807f7b849df0b1c6e1b215` | `f8ffde4140793c953ef73bce6711a41207a4704ad9f50034b4eafa8dfbfca384` |

All rows contain the same high-contrast sparse enclosure, route sentinels, and proposed 1, 2, 4, 8,
16, and 32 metre gates on forward, backward, left, and right axes. Those labels are authored metric
witnesses; emulator key-hold time is not converted into metres.

The F2 debug path has a manifest-root-owned state machine and exact capability/session/generation
commands. Its active Full owner emits the seven versioned `BoundaryProbe` event kinds, owns
observations and explicit close, permits exactly one authenticated reopen in recovery, and performs
the open/close sequences in `NonCancellable` contexts. It directly calls
`navigator.openStage(..., StageStyle.Full)` and never invokes the existing auto-close-on-pause
helper. The receiver and experiment bridge are absent from release output.

A fresh regenerated F2 project matched current `dist` byte-for-byte for all nine generated files.
The generated `BoundaryLabScene.kt` was 15,462 bytes with SHA-256
`e4d2d985359f4b26e369a1ec3ad184e5eaf09172230c5f574b80d8dcffe48725`; all 211 enumerated entity
names passed `^[A-Za-z][A-Za-z0-9_]*$`. Forced debug and release Kotlin compilation executed 32/32
tasks and succeeded.

## Native build and baseline receipts

All three rows were built, installed, and launched through this MCP's `fleet_build`; each receipt
binds the exact spec, Gradle input tree, APK, installed bytes, emulator identity, process start,
launch component, and capture.

| Row | APK SHA-256 (bytes) | Native receipt | Receipt capture SHA-256 | LOOKed baseline |
| --- | --- | --- | --- | --- |
| M0 | `37f9c91e3c11a095b264037ba4c775a3cd2e0cc55107b77edb265b77294e9d00` (31,879,382) | `fe741c271b0e2e6273317e3f88916d18b0233962fdddd61e031d216f62b612b1` | `79130b9c77abd74085b5c132806cbb1b460576f76f6685373d1a0774a4bfd6db` | Livingroom passthrough pixels remain visible behind the cyan/magenta grid and nested cyan forward gates. |
| F1 | `1f178b610a7711efa3a32fb8ef4603e5c0ee0e84d0c194c17f7e8a5a41f78c59` (31,704,650) | `bd0683840f5ebe714dec7b3126ca5de2c27b0c32c44df0f068af5d478b58a080` | `c76de2c7e7873f2cddff7d64044a892acdd55384ad171f6dd836702bdea36c60` | The same enclosure and gate corridor render against an opaque black Full-space background; Livingroom pixels are absent. |
| F2 | `e249f82b2c3006dc70e8690ac1a96ae9ae65ab6bb01ae16c5e8c9e739040b868` (31,770,292) | `c214dc7be587b2f515b94e39049d940a31a2639138424e0318f37f878846e67c` | `79130b9c77abd74085b5c132806cbb1b460576f76f6685373d1a0774a4bfd6db` | Before dynamic open, the Mixed root is pixel-identical to M0. Active dynamic Full is deliberately deferred to CP3. |

Receipt-bound immutable artifacts:

- M0/F2:
  `/Users/sushantsrikrish/.pico-mcp/ledgers/artifacts/79130b9c77abd74085b5c132806cbb1b460576f76f6685373d1a0774a4bfd6db.png`
- F1:
  `/Users/sushantsrikrish/.pico-mcp/ledgers/artifacts/c76de2c7e7873f2cddff7d64044a892acdd55384ad171f6dd836702bdea36c60.png`

Each narrow pixel claim was recorded as `vision_verified` through `record_verification` with its
app-specific native receipt. The F2 bytes equal the already-LOOKed M0 artifact, but its provenance is
separately bound to the F2 receipt. The raw MCP fleet and ledger responses are under
`/private/tmp/pico-immersive-phase1/cp2/`; their hashes are:

| Row | Fleet response SHA-256 | Ledger response SHA-256 |
| --- | --- | --- |
| M0 | `a8dd9ddb2d2439e2019005f01d2a17428382ff7adfb4ab5f88e19f11487fdcd3` | `891b2349847db591e69eb7fada9dc9dea53332d57b416a2b83b48a56b5ea5900` |
| F1 | `826d7633bc7be1cc1c6ff4d17f871aaabe6989eee5795f4b1f8a8da3ba85b675` | `dfe4f768d3b31dcf56a65222eb96157fd0eee14c234ee233114a4b466755535f` |
| F2 | `ad54aa531e3eb61afb6ab3a5e9eecd87f673026082cfeaa1f2eed059d81de2ac` | `efd0065ee2f1f2b72b1c2e5589966442b0639b1b4ac070df7472c509aedf6819` |

## Fresh-launch dialog monitors and LOOK register

Each successful row received five `check_crash` samples at approximately 0, 15, 30, 45, and 60
seconds. Every sample reported `processAlive:true`, `healthy:true`, and `crashCount:0`. The 0, 30,
and 60 second GUI frames showed no ANR or system dialog. Full-resolution captures and monitor records
remain external.

| Row | Duration | Retained and LOOKed capture paths | SHA-256 | Monitor record SHA-256 |
| --- | --- | --- | --- | --- |
| M0 | 69.102 s | `/private/tmp/pico-immersive-phase1/cp2/m0-fixed-dialog/01-gui_capture-0.png`; `04-...` and `07-...` are byte-identical | `cb5f9475d6aaf646784b1462e87647776e30f7a75a03e8566858298999dcdf9e` | `6d9e1567937f07c7a7817e783ff41e71eb572d6dcc9c8ff67bdc96b75f6d4a60` |
| M0 | post-monitor settle | `/private/tmp/pico-immersive-phase1/cp2/m0-fixed-dialog/08-capture_settled-0.png` | `84eef968b053b3ac449a5d077210a1d10698170474192624bc9dc381c459b004` | same monitor record |
| F1 | 62.940 s | `/private/tmp/pico-immersive-phase1/cp2/f1-dialog/01-gui_capture-0.png`; `04-...` and `07-...` are byte-identical | `b4acf11e515a0c8eab4f874cf10f378a64501db245104ab62dd633f61b84cab2` | `127eb69201b79d6fda630ae55deeb019b8b908700337cf689548092a328d9889` |
| F1 | post-monitor settle | `/private/tmp/pico-immersive-phase1/cp2/f1-dialog/08-capture_settled-0.png` | `39d4191f7bc60194addecb9617d6d43524722488af889b6f204095c2eb3b243f` | same monitor record |
| F2 | 69.247 s | `/private/tmp/pico-immersive-phase1/cp2/f2-dialog/01-gui_capture-0.png`; `04-...` and `07-...` are byte-identical to M0 | `cb5f9475d6aaf646784b1462e87647776e30f7a75a03e8566858298999dcdf9e` | `df35c12f5c0eb53aba271f79a57caa769ef6ed914e002a524ae2db1c1e931973` |
| F2 | post-monitor settle | `/private/tmp/pico-immersive-phase1/cp2/f2-dialog/08-capture_settled-0.png`, byte-identical to M0 | `84eef968b053b3ac449a5d077210a1d10698170474192624bc9dc381c459b004` | same monitor record |

The repeated frame names are abbreviated only in this small summary; the external directories retain
every image. Equal hashes were verified before reusing a LOOK adjudication.

## First-light failure and retained lesson

The first M0 fleet launch built and installed but could not bind a PID because CP0's Welcome Space
still owned the spatial stage. Its 60-second monitor showed the system Decorate Space/home view, not
M0, so no app claim was made. The exact Welcome Space and Claimsight packages were stopped through
MCP `app_stop`; the looked cleared-home frame is
`/private/tmp/pico-immersive-phase1/cp2/home-cleared-images/gui_capture-1788208254296-0.png`, SHA-256
`ae27b1de6fb137d0a428584cc207790d180416131fd2ee0168c7a37409e199da`.

The next exact M0 launch crashed immediately. Bounded MCP logcat showed
`IllegalArgumentException: Invalid name!` from `Entity.setName` in the first enclosure primitive.
SDK 0.13.3 bytecode inspection established the grammar: at most 2,048 UTF-16 characters, each one an
ASCII letter, digit, or underscore. Generated names such as `..._floor_x_-40` and
`..._perimeter_-40.0_40.0` contained rejected punctuation.

The failure is retained at
`/private/tmp/pico-immersive-phase1/cp2/m0-crash-log-response.json`, SHA-256
`4ae7a2210439baf932cac7fcf0545c09afbfdea6b5397c2f2a450fc0064d11b3`. A focused regression failed
before the fix and passed after coordinates were removed from names in favor of positive ordinals.
All 186 Boundary Lab/root names in the focused audit and all 211 names in regenerated F2 then passed
the SDK-safe grammar. The corrected M0 live run and 69-second monitor prove the runtime repair.

The exact original error was first sent to `pico_fix`; it correctly reported a novel gotcha. After
the live repair, `pico_fix` recorded the tested `entity-setname-raw-coordinate` lesson at
`/Users/sushantsrikrish/.pico-mcp/lessons.json`. The response is
`/private/tmp/pico-immersive-phase1/cp2/m0-crash-lesson-response.json`, SHA-256
`45fd47332191a451d7f2f3aca33101679e29a1272195a33e63c0d649ca7e546b`.

## E1 and evidence ceilings

Claimsight remains E1; CP0's clean rebuilt bytes, install binding, 137-second monitor, and looked
scene-specific baseline are reused without relaunching it here. See [CP0](CP0.md). Its APK SHA-256 is
`7ecce31ec0a5ede24c88e97e0aca2ec82dc467f0a639402661b5749ee5678bbf`; the looked Full-stage landmark
frame is `/private/tmp/pico-render/cp0-claimsight/claimsight-settled-baseline.png`, SHA-256
`eda6f367c9686bdbac0b6ed2079cb324f0bb0e466acab559fbfc4a345908faef`.

CP2 establishes build/install/launch provenance and narrow baseline pixels only. It executes no
movement, dynamic Full entry, boundary crossing, ejection, or recovery sequence.

| Register item | Status after CP2 |
| --- | --- |
| U1 | Open. No route or ejection attempt occurred. |
| U2 | Open. The dynamic-vs-manifest hypothesis has not been exercised. |
| U5 | Partially informed: the forward corridor and multiple nested gates are clearly rendered at baseline, but the 32 m label/gate was not individually identified and no required route was walked. |
| U6–U9 | Open. No transition trace exists yet. |
| U10a/U10b | Closed only for the exact Claimsight CP0 bytes/runtime/baseline. |
| U11 | Structural direct-open path and F2 Mixed-root launch are built; active dynamic Full and its complete trace remain open. |
| U12 | Open. No boundary recovery was attempted. |
| U16 | Open. CP2 baseline samples do not establish atomic cross-signal timing. |
| U17 | Version-qualified compatibility remains closed only to the CP0 extent; matched 6.0 Editor authoring remains open. |
| U18 | Open. F2 did not request or visually enter the secondary Full Stage in CP2. |
| U19 | Open for dynamic takeover; CP2 only binds the manifest launch component. |

No finding transfers to hardware. The physical device was never selected, and U3/U13/U14 remain
open.

## Tool surface, deviations, and gates

- CP2 adds no public MCP tool. Doors remains 18 and the full-surface count is unchanged. No tarball
  is required for this checkpoint.
- Package version remains 37.0.0. All 53 npm script keys are unchanged; the existing
  `test:conformance` value now owns `test/boundaryprobe.mjs`.
- `benchmarks/**` and `test/agentbench-*` remain byte-identical to base `8b0ed19`.
- There is no material plan deviation. The only live correction was the SDK-required entity-name
  sanitization above; it preserves geometry and matrix semantics. F2's active Full open remains in
  CP3 as designed.

Final gates were run after a fresh build:

| Gate | Result |
| --- | --- |
| TypeScript build | PASS |
| Boundary Probe owning suite | PASS, 8/8 |
| Conformance | PASS, including Boundary Probe 8/8 |
| SpatialBench | PASS, 0 failures; corpus remains exactly 28 briefs |
| Archetype and project-generation regressions | PASS |
| `test/docsmeta.mjs` | PASS, 0 failures |
| `test/adoption-safety.mjs` | PASS, 48/0 |
| `test/distribution-adoption.mjs` | Expected baseline only, 41/2: the two known stale Linux-lane and suite-count assertions; no third failure |
| Doors surface | PASS, exactly 18 tools |
