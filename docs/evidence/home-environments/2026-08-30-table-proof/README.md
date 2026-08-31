# CP3 deferred TABLE proof — Livingroom Day

Status: **vision verified on `emulator-5554`**.

The receipt-bound selector verification identified `Livingroom Day` uniquely, a fresh app launch
kept the same exact process alive without an ANR/error dialog for more than 60 seconds, and the app
selected the measured large TABLE. The final settled frame was LOOKed at before
`record_verification` minted a `vision_verified` ledger entry.

No command targeted the attached physical device. Meta VR CLI invocations used the exact
`emulator-5554` serial. The registered capture tools internally read the attached-device inventory
before targeting that serial; they issued no command to the physical serial. No calibration,
snapshot save/load, gate save, or release/version operation occurred.

## Selector handoff and fit

The authoritative CP2 pair is
[holdout-2 switch](../2026-08-30-selector-live/holdout-2-switch-call.json) followed by
[holdout-2 verify](../2026-08-30-selector-live/holdout-2-verify-call.json). The verify result is
`selected_verified`, with a changed snapshot and one histogram match: `Livingroom Day`. Both calls
bind dataset digest
`8421df39dc14421baeabc3df9f15d34787ea10f44907ac338f3bd741d6cfab7d`.

The mission brief requires TABLE footprint `0.25 × 0.18 m`. Static ranking selected
`Livingroom Day` using measured potential TABLE `0.782631 × 0.464378 m`, fit ratio
`2.579877777777778`, preferred tier, and content scale `0.7739633333333333`. The fresh CP3 query
observed that same large TABLE at
`[0.7826310396194458, 0.18812690675258636, 0.4643775224685669]`; observed scale was
`0.7739625374476115`.

## Fresh runtime and 60-second dialog monitor

The fresh native run is recorded in [the build call](fresh-fleet-build.live4.call.json) and
[validation](fresh-fleet-build.live4.validation.json):

| Field | Value |
| --- | --- |
| receipt | `e5698c6c3cbc557df7c8b790901c883c655e140b043bffe494c7f05ab41ea743` |
| launch | `2026-08-31T02:52:49.071Z` |
| component | `com.fleet.swanmissiontable/.platform.LaunchActivity` |
| PID / start ticks | `21207` / `8243193` |
| model / build | `swan_arm64` / `4399` |
| boot ID | `c0bd8c41-7928-476a-ae8a-a71d89465686` |
| APK SHA-256 | `67e01b73b23b5adf1ad8d26a3912167dfd30f49a0cb0ea7a899ec11986173d4c` |

The first monitor ended at `59.999990 s` and was rejected. The authoritative second monitor sampled
offsets 0/15/30/45/60 and ended at `60.501574 s` (`67.091616 s` including command runtime). Every
sample retained PID/start/boot and the resumed component, with `dialogHits=[]`. Global
`mCurrentFocus`/`mFocusedApp` fields were absent from `dumpsys window windows`; no values are
inferred for them. The exact retained transcript is [dialog-monitor.log](dialog-monitor.log).

Launch-scoped log review found no package ANR, `FATAL EXCEPTION`, `E/AndroidRuntime`, input dispatch
timeout, or 5000 ms FocusEvent wait. `check_crash` independently returned `healthy:true`,
`processAlive:true`, `crashCount:0`; see [runtime log](missiontable-runtime.log) and
[check receipt](check-crash.live4.01.call.json).

## Fresh mesh classification

The fresh query is [query-scene-anchors.live4.01.call.json](query-scene-anchors.live4.01.call.json),
validated by
[fresh-environment-classification.live4.01.validation.json](fresh-environment-classification.live4.01.validation.json).
It is bound to the fresh receipt and PID/start pair above.

| Field | Exact result |
| --- | --- |
| status / tracking | `ready` / `RUNNING` |
| snapshot | `4804216a537ea192cc96043e3114f5785c7a87c1752e053c61b38780b1f9b764` |
| request | `0a6438774d0d4863bdb618186a5fc0e3` |
| geometry | `5c82984f1170ab293a3c304103347fa099730715d4103a801cdc286ec1effb3d`, 9,305,931 bytes |
| total / requested matches | `58` / `5` |
| classification | unique `Livingroom Day`; requirements fit |

Complete histogram:

```text
UNKNOWN 28; SCREEN 1; PLANT 3; TABLE 2; CHAIR 3; LAMP 6; WALL_ART 2;
CABINET 5; WINDOW 2; CEILING 1; FLOOR 1; WALL 2; DOOR 2
```

Requested-label observations:

- TABLE `0.176012516 × 0.176883101 m` footprint.
- TABLE `0.782631040 × 0.464377522 m` footprint (selected mission support).
- FLOOR `6.867675781 × 4.439027309 m` footprint.
- WALL_ART `0.357558727 × 0.008718312 m` and `0.337964237 × 0.008749247 m`; these
  extents remain advisory and are not a ranking requirement.

`XiataAncientPath` is retained only as coarse guest context. It is not discriminating and is not
used to infer the selected environment.

## Settled capture and LOOK

The app was sent `mission:launch` and then `mission:pause` to freeze authored animation; the TABLE
selection did not change. The drive receipt is [pause-drive.json](pause-drive.json). Exact
PID/start/component/boot probes bracketed capture; see
[capture-process-bracket.json](capture-process-bracket.json).

`capture_settled` accepted two byte-identical frames:

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| [full settled frame](livingroom-day-table-settled.png) | 2160×2158, 2,800,528 bytes | `17cea46920ee2626fb8810813aebb4efdde0a2592093e293e0e5096310770bf9` |
| [lossless panel crop](livingroom-day-panel-crop.png) | 760×430, 255,875 bytes | `012596a22435f59bcb2320022cd513079ca0b4e5c19c5f51484cc17650070e38` |

The crop is derived from the full settled frame; it is not a second independent capture. The
settled tool receipt and validation are
[capture-settled.live4.01.call.json](capture-settled.live4.01.call.json) and
[capture-settled.live4.01.validation.json](capture-settled.live4.01.validation.json).

Verbatim eye verdict:

> The full-resolution settled frame visibly shows the blue lunar diorama resting on the round dark Livingroom table at a believable tabletop scale; the panel visibly reads `ANCHORS TABLE + runtime re-query` and `SURFACE TABLE 0.78 x 0.46 m | scale 0.77`, with no FLOOR fallback or error dialog obscuring the scene.

Visible panel text:

```text
SWAN MISSION CONTROL
PHASE PAUSED...
ANCHORS TABLE + runtime re-query
WALL_ART NOT PRESENT → TABLE fallback
SURFACE TABLE 0.78 x 0.46 m | scale 0.77
```

The WALL_ART line is the app's advisory fallback to TABLE, not a TABLE-to-FLOOR fallback. The
latest runtime support line is
`TABLE selected label-level bounds=0.78263104x0.46437752 scale=0.77396256`.

[record-verification.json](record-verification.json) records ledger entry 3 as
`vision_verified`, with immutable ledger artifact SHA-256 equal to the settled frame. It
intentionally omits `runReceiptId`: this later settled capture is not byte-identical to the native
launch-receipt capture.

## Superseded attempts retained

The earlier live directories are evidence of harness/capture refinement, not proof:

- `live1`: fresh launch and monitor were healthy; a canonical requested-label order check rejected
  the already-persisted query. No final capture was accepted.
- `live2`: query/classification succeeded and capture returned settled, but the harness incorrectly
  required non-null `lastValidCaptureRef`; the production settled contract intentionally returns
  it as null. The diagnostic camera view did not frame the content.
- `live3`: query/classification succeeded. One small downward camera drag improved framing, but an
  orbit-settle attempt timed out; the animated diorama then prevented byte-exact settled capture.
  A later exact-serial launch/pause diagnostic isolated the animation as the cause.
- `live4`: corrected label-order and settled-reference validators passed; no camera movement was
  made during this attempt. Pause enabled the two-frame byte-exact settled capture above.

All retained `live1`–`live3` JSON files remain superseded and must not be cited as the TABLE proof.

## Honest remaining boundaries

- No physical-device or headset proof; this is `C0_emulator`, not `device_verified`.
- No metric-camera claim because calibration was prohibited and predates the boot.
- No generalization to another emulator version, boot, picker layout, host OS, or display geometry.
- WALL_ART remains advisory until its fit semantics/extents are deliberately modeled.
- Mesume Day remains excluded because its public anchor payload contains zero geometry.
