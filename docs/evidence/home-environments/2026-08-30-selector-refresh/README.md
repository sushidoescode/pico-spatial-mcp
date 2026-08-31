# Livingroom selector range refresh

This directory records an independently labelled calibration refresh for `Livingroom Day` and
`Livingroom Night`. It extends the v1 dataset without changing its ID, filename, schema version, or
CP1 `measurement.sourceCommit`. The refresh is based on dataset commit
`7f74b2a0c2ca9aa40b192a93c68b01f04ec94af2`.

The accepted observation set contains five Livingroom Day reads (the CP1 read plus four reads here)
and two Livingroom Night reads (the CP1 read plus the read here). Missing histogram labels were
counted as zero when deriving each complete envelope.

| Tile | Accepted reads | Total anchors | Complete histogram ranges |
| --- | ---: | --- | --- |
| Livingroom Day | 5 | `[51,60]` | `CABINET[3,5] CEILING[0,1] CHAIR[3,4] DOOR[1,2] FLOOR[1,2] LAMP[6,8] PLANT[1,3] SCREEN[0,1] SOFA[0,1] TABLE[1,2] UNKNOWN[26,28] WALL[1,2] WALL_ART[1,3] WINDOW[1,2]` |
| Livingroom Night | 2 | `[55,56]` | `CABINET[3,3] CHAIR[3,3] DOOR[0,2] FLOOR[2,2] LAMP[6,7] PLANT[3,3] SCREEN[0,1] SOFA[1,1] TABLE[1,2] UNKNOWN[25,26] WALL[3,3] WALL_ART[2,3] WASHING_MACHINE[1,1] WINDOW[2,2]` |

## Measured potential and live surface observations

The CP1 `surfaces` arrays remain unchanged as measured-potential proposal inputs. Static ranking uses
those arrays; it does not claim that a proposed surface is present in a later instantiation.
Classification uses every `extentClusters` representative and its allowed per-reading presence-count
range, matching X, Y, and Z within the dataset's `0.01 m` tolerance. After unique histogram identity
and cluster validation, `switch`/`verify` must confirm that the receipt-bound live mesh satisfies the
globally ranked mission tier (or every simultaneous explicit requirement).

The four FLOOR/TABLE representatives are:

- small FLOOR: `[2.237663,0.008483,1.502388]`
- large FLOOR: `[6.867676,0.0000016,4.439027]`
- small TABLE: `[0.176013,0.174682,0.176883]`
- large TABLE: `[0.782631,0.188127,0.464378]`

Reads 3 and 4 falsified the earlier Livingroom Day guarantees: all four Day representatives have
presence range `[0,1]`, and its `guaranteedSurfaces` arrays are empty. Livingroom Night still
guarantees both FLOOR representatives and the small TABLE; its large TABLE is optional (`[0,1]`).
Because ranking uses measured potential, both Livingroom Day and Livingroom Night propose the same
large TABLE at approximately `0.774` Swan mission scale; stable dataset order puts Day first. A live
Day observation with only the large FLOOR and small TABLE therefore passes identity/cluster checks
but fails the mandatory preferred-TABLE tier. `WALL_ART` remains advisory and does not participate in
ranking or extent matching.

## Content-addressed authority

The packaged dataset's `measurement.refreshProvenance` is the machine-readable authority. The
`stable_query` role covers the read and MCP-call envelopes. The
`selected_calibration_provenance` role covers selected-state frames and their provenance records.
Hashes below are lowercase SHA-256 of the committed bytes.

| Role | File | SHA-256 |
| --- | --- | --- |
| stable query | `livingroom-day-refresh-call-1.json` | `7a57010bce2bc1dda41928efb966f8bca33a6d86f4bd5486b02b3e6cec039ef6` |
| stable query | `livingroom-day-refresh-call-2.json` | `0b71bcd2ea66d4c5ff37e9eaad53e8282d50d04665429f82bd6cd25d1633bd2d` |
| stable query | `livingroom-day-refresh-call-3.json` | `cd41128e8d4557e59fff3ced0a5eeb3f5f4df70cb0b9ff31ee3adcf83208a7c6` |
| stable query | `livingroom-day-refresh-call-4.json` | `3134586339a0a1e287e70a46583c9a23b6638c64c0fd9520b01e888ab2f68643` |
| stable query | `livingroom-day-refresh-read-1.json` | `3861fbb43857aa2dbd43ec847004b671569ce604a550328d64e92100d79ea757` |
| stable query | `livingroom-day-refresh-read-2.json` | `0387cdcc2cebeee32081ba0b8c0d4117fd2212846a921b94ad169626c79251ef` |
| stable query | `livingroom-day-refresh-read-3.json` | `4ab2e4116959df546144adb23b3b04a98f771b1fcb26d7912f27829eab86ff7e` |
| stable query | `livingroom-day-refresh-read-4.json` | `70e72bc15fe9326e4d40e705a3aad35e45d8dacd6f3929dbf162a7a055b61795` |
| calibration provenance | `livingroom-day-selected-2.png` | `c8dab02d14f73efc8ac954d57d8aec38bfa151149799933e6899be799b419a7a` |
| calibration provenance | `livingroom-day-selected-3.png` | `c8dab02d14f73efc8ac954d57d8aec38bfa151149799933e6899be799b419a7a` |
| calibration provenance | `livingroom-day-selected-4.png` | `c8dab02d14f73efc8ac954d57d8aec38bfa151149799933e6899be799b419a7a` |
| calibration provenance | `livingroom-day-selected.png` | `c8dab02d14f73efc8ac954d57d8aec38bfa151149799933e6899be799b419a7a` |
| calibration provenance | `livingroom-day-selection-provenance-1.json` | `71e6456024c56eef2cec437b3e3e9a972d5534e792edb1e549273d7f11a6ca63` |
| calibration provenance | `livingroom-day-selection-provenance-2.json` | `37563a88433473507553b42b747cfb0861c542d606dcf2958a8e38442d8238ff` |
| calibration provenance | `livingroom-day-selection-provenance-3.json` | `8efecd1cacc64ac9de385b9b2cf1111c4e66490587a6cfccd324c49a6d42378a` |
| calibration provenance | `livingroom-day-selection-provenance-4.json` | `ea393f6232be0b729e7b58fd0e06324cc8f05c07b8f163ca04019f7ff0a18a22` |
| stable query | `livingroom-night-refresh-call-1.json` | `754bbdbeefc720e957fadbd92e3b448e173037d490ff9548a58ccbfbe185880c` |
| stable query | `livingroom-night-refresh-read-1.json` | `493bb06c0f5384d9ece881074b1e5e4bd989d404b2fc228aa8c0b7a2f4ce2189` |
| calibration provenance | `livingroom-night-selected.png` | `36def3b05eb138b108c3b84d0855ea6d8193e0b657d2b2f39d8f079172c49e93` |
| calibration provenance | `livingroom-night-selection-provenance-1.json` | `78529efbc8fffdea642243fae5ce60cab7837e4671eac1033dd738f40b159033` |

## Calibration-only caveat

Each selected-state frame labels the environment associated with the adjacent stable query. It is
not a later receipt-bound holdout, does not prove that the selector switched environments, and does
not establish switch success. This implementation checkpoint performs no selection, calibration,
capture, or live verification action. Only suffixes 3 and 4 were accepted by this amendment. The
committed suffix-40 files are retained as same-instantiation diagnostics, while suffix 40 and every
`selector-live` holdout artifact remain excluded from calibration counts and packaged refresh
provenance.
