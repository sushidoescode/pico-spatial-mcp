# CP2 live `select_home_environment` evidence

Status: **authoritative holdout-2 switch verification succeeded**.

The full-surface `select_home_environment` tool ranked `Livingroom Day` for the Swan mission-table
brief. Its integrated host automation failed safely and returned `manual_switch_required`. A
guarded external macOS CGEvent selection then changed Bedroom Day to Livingroom Day, and one
receipt-bound `verify` call established the switch from a changed mesh snapshot and a unique
Livingroom Day classification.

No environment identity is inferred from a click, selection outline, or scene ID. The current
scene ID is `XiataAncientPath` for every measured tile and is non-discriminating. No command
targeted the attached physical device. Exact device work used Meta VR CLI with
`--device emulator-5554`. No calibration, snapshot save/load, gate save, or release/version
operation occurred.

## Runtime and dataset binding

| Field | Value |
| --- | --- |
| live selector source HEAD (pre-squash) | `7f9be09273954d25e51fabd17d030fd26362fa35` |
| MCP session | `d983a64c-8227-41f4-b633-a00042595fc3` |
| surface / serial | `full` / `emulator-5554` |
| product / model / build | `swan` / `swan_arm64` / `4399` |
| boot ID | `c0bd8c41-7928-476a-ae8a-a71d89465686` |
| package / component | `com.fleet.swanmissiontable` / `.platform.LaunchActivity` |
| PID / start ticks | `4196` / `2711055` |
| native receipt | `4b228502cb2506ee9aa5a84f810ac122ac9d4e834f0d6dba6423443599e54845` |
| APK SHA-256 | `67e01b73b23b5adf1ad8d26a3912167dfd30f49a0cb0ea7a899ec11986173d4c` |
| dataset | `pico-emulator-6.0-home-environments-v1` |
| canonical dataset digest | `8421df39dc14421baeabc3df9f15d34787ea10f44907ac338f3bd741d6cfab7d` |
| raw dataset-file SHA-256 | `1effdaff26f5c2daed5d85c71cf9be25d7c435b706333a107b1aad6d60a052af` |

The canonical digest binds the parsed dataset content used by rank, switch, and verify; it is not
the raw-file digest. A changed or missing digest invalidates a saved baseline before live
dependencies run.

## Rank and switch contract

The Swan brief requires a preferred TABLE of at least `0.25 × 0.18 m`, target footprint
`0.68 × 0.42 m`, fill fraction `0.7`, FLOOR fallback at least `0.8 × 0.55 m`, and advisory
WALL_ART. Livingroom Day and Night tie on measured-potential TABLE `0.782631 × 0.464378 m`, fit
ratio `2.579877777777778`, proposed scale `0.7739633333333333`; stable dataset order selects Day.
Day's guarantees are empty, so ranking does not assert that the TABLE is present in a later
instantiation.

The authoritative [switch call](holdout-2-switch-call.json) ended with:

```text
status=manual_switch_required
target=Livingroom Day
baselineSafe=true
detail=select_scene_button was not found
MCP transport isError flag=absent (not true)
```

That is the intended fail-closed result: production AX automation did not reach a tile click. The
tool returned a receipt-bound Bedroom baseline and durable marker for later `verify`.

Bedroom baseline:

- Snapshot `91ed72652eb0f7d17f2ffa90f03a6ddfaf969b5077d45d84989a2e86bd611ab6`.
- Request `61c9c37e67704a2e80db4413eabf53f5`.
- Geometry `c2825e6464ce61d339fe3f116199d3bbcd5c9beaec76d935ca5800aa4f6d6f6e`,
  11,789,704 bytes.
- Total 42; histogram `BED 2, UNKNOWN 14, CHAIR 1, CURTAIN 3, PLANT 6, CABINET 3,
  LAMP 7, WINDOW 2, WALL 2, FLOOR 1, DOOR 1`.
- FLOOR extent `[5.255132675, 0.000000477, 2.964813232]`.
- Two-read drift was within policy and all five query actions applied.

## Guarded host selection chronology

1. Bedroom Day selected frame: `2026-08-31T02:23:34Z`.
2. Pre-WorldSpace observation: `02:24:39.663Z`.
3. SWITCH call: `02:25:03.569Z–02:25:15.521Z`.
4. Durable baseline marker: `02:25:13.167Z`.
5. Later coarse WorldSpace observation: `02:25:39.665Z`.
6. First Livingroom picker open observed zero exact dialogs and stopped before a tile click.
7. Second guarded open selected Livingroom Day at `02:26:41Z`, after the marker.
8. VERIFY call: `02:28:00.307Z–02:28:11.285Z`.

The WorldSpace row at step 5 predates the recorded Livingroom selected frame. It is not post-click
evidence and remains coarse consistency only. The effective-switch proof is the marker-ordered
guarded selection followed by the fresh changed mesh and unique classification below.

Verbatim LOOK verdicts:

> The blue selection outline is visibly around the Bedroom Day tile; no other tile is outlined.

> The Bedroom Day room and mission-table FLOOR-fallback diorama are visible; the Environment Preview dialog is absent.

> The blue selection outline is visibly around the Livingroom Day tile; no other tile is outlined.

The corresponding provenance and frames are
[Bedroom JSON](holdout-2-bedroom-day-host-selection.json),
[Bedroom PNG](holdout-2-bedroom-day-selected.png),
[safe first-open failure PNG](holdout-2-livingroom-open-timeout-main.png),
[Livingroom JSON](holdout-2-livingroom-day-host-selection.json), and
[Livingroom PNG](holdout-2-livingroom-day-selected.png).

Automation verdict: the guarded CGEvent lane is usable but not perfectly reliable on this exact
host geometry. Bedroom succeeded; the first Livingroom open failed safely before a tile click; the
second guarded attempt succeeded. Integrated AX selection remained unavailable. On guard failure,
the tool must continue to return `manual_switch_required`; it must never infer success from the
requested tile.

## Receipt-bound verification

Exactly one [verify call](holdout-2-verify-call.json) used the switch call's exact runtime,
baseline, and marker objects. It returned:

```text
status=selected_verified
target=Livingroom Day
classification.status=unique
classification.histogramMatches=[Livingroom Day]
missingRequestedLabels=[]
surfaceExtentMultisetsMatch=true
requirementsFit=true
MCP transport isError flag=absent (not true)
```

Fresh post state:

- Snapshot `b3bd0b23125c01b732e0c553ca52b6e716de64394fa7327f6699aa9537e8d0d9`,
  changed from the Bedroom baseline.
- Request `17c47c56c0f74cd4af2523e7e8584b79`.
- Geometry `6d45d880be0eb7186a618012b7b6cce6f8049cbde3fdddba04a2892d92b1e97c`,
  9,306,209 bytes.
- Total 58; requested-label matches 5.
- Histogram `UNKNOWN 28, SCREEN 1, PLANT 3, TABLE 2, CHAIR 3, LAMP 6,
  WALL_ART 2, CABINET 5, WINDOW 2, CEILING 1, FLOOR 1, WALL 2, DOOR 2`.
- TABLE extents `[0.176012516,0.174681515,0.176883101]` and
  `[0.782631040,0.188126907,0.464377522]`.
- FLOOR extent `[6.867675781,0.000001606,4.439027309]`; two WALL_ART anchors.
- Two-read drift was within policy and all five query actions applied.

This changed snapshot, complete histogram, extent multiset, required-label fit, and unique match
are the discriminating proof. If multiple environment ranges overlap the observation, if required
extents do not fit, or if any receipt binding fails, `verify` returns `verification_failed`; it
never chooses from the tile click alone.

The source HEAD above identifies the immutable tree that made the live calls; it is an operational
pre-squash commit, not the final CP2 history commit. A later review tightened the final selector so
a ready post query must also carry the complete stable-read, runtime-binding, five-action, and
lossless-geometry receipt chain before classification. The final regression suite parses this
exact holdout-2 structured result under that stronger output contract and rejects every tested
missing or mismatched receipt class. That post-live hardening performed no additional host click or
device query; the committed raw live evidence remains unchanged.

## Scene-ID source

The guest context comes from the `WorldSpaceDB, getSpace` logcat row's
`envId=XiataAncientPath`, corroborated by same-moment DataTracking JSON. It is not a property or
dumpsys environment field. The original citations are
[scene-id-source.log](../2026-08-29-pico-emulator-6.0/scene-id-source.log) and
[selection-scene-source.log](../2026-08-29-pico-emulator-6.0/selection-scene-source.log).
`XiataAncientPath` remained constant through all six tiles. The gRPC XrOptions route is unused.

## Content-addressed holdout files

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `holdout-2-switch-call.json` | 79,391 | `a3e41d0cc94113c9a5b19dbc41a09d75454a7cd32fc306f417ed20a37ec15126` |
| `holdout-2-switch-validation.json` | 11,297 | `c16194634fe3ffe6bbc420d91ad7c590c7b2d7d16ae8ee93f7caa5022769f973` |
| `holdout-2-verify-call.json` | 116,093 | `178fc4bd59fc78f26d5194935b14fe438d4e39314b74b6133315ab2f6b50a5f5` |
| `holdout-2-verify-validation.json` | 15,357 | `050ff8ee6f33fbbb7185f29f45d0d62619d1765b402244e46a8f7ad830cc5d3b` |
| `holdout-2-bedroom-day-selected.png` | 661,505 | `5464d1a1e964100b9735c0d3f01cc22d9b62b652a5d7e55f1d996dd3b1017b1b` |
| `holdout-2-livingroom-day-selected.png` | 661,733 | `c8dab02d14f73efc8ac954d57d8aec38bfa151149799933e6899be799b419a7a` |
| `holdout-2-livingroom-open-timeout-main.png` | 4,104,468 | `c5d8b56845f7c77fb4f4e7b0a883fb41b9a7bb6157089bd0f30e4f57131caae5` |

The two validation JSON files preserve canonical response hashes and freshness checks.

## Tool counts and packaged dataset

The final pre-squash operational tree ran `npm run build && npm run test:tarball` from
`2026-08-31T03:13:21Z` through `03:13:38Z` with zero failures. A clean installed package
runtime-measured 252 full-surface tools on macOS, 18 doors tools, and 18 tools when the surface is
unset. `select_home_environment` is full-only. Four macOS GUI registrations collapse to one
non-macOS explanatory stub, so Linux and Windows are source-derived as
`252 - (4 - 1) = 249`; neither is represented as a native measurement.

The installed package contained exactly
`assets/home-environments/pico-emulator-6.0.v1.json`; its bytes matched the source dataset. The
installed selector parsed it, retained Mesume Day's exclusion, retained the refreshed Livingroom
clusters, and ranked the complete Day/Night measured potential with the canonical dataset digest.
[tool-counts.json](tool-counts.json) is the machine-readable receipt. Version remained `37.0.0`.

## Historical and excluded evidence

- Unsuffixed `holdout-*` files are failed holdout-1 history. Its `verify` returned
  `verification_failed` / `classification_extent_mismatch` under an older small-FLOOR
  cardinality model. It is not the current result.
- `rank-result.json` and `switch-result.json` are superseded `b6bc0ef` development-checkpoint
  evidence. [tool-counts.json](tool-counts.json) was refreshed from the final pre-squash
  operational tree and installed-tarball gate; it is the current count/shipping receipt.
- Suffix-40 refresh files are same-instantiation diagnostics. They are committed for audit but
  excluded from accepted read counts and packaged refresh provenance.
- `calibration-3-away-bedroom-selected.png` is guarded away-state host provenance only, not a new
  calibration read and not environment identity.
- Mesume Day remains excluded from automatic selection: its public payload was rejected because
  stable anchor 33 had zero vertices and indices.
- WALL_ART remains advisory; FLOOR/TABLE extents drive fit and classification.

## Remaining unverified boundaries

- Picker automation on another emulator version, host OS, display layout, QEMU process, or without
  macOS Accessibility permission.
- Physical-device/headset behavior and metric-camera measurements.
- Mesume Day fit until a valid lossless public query succeeds.
- Any exact-count promise outside the observed ranges.
