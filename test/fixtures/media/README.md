# Media fixtures — provenance

**None of these files is a device capture, a screen recording, or a copy of anyone else's
content.** Every byte is synthesised by `make-fixtures.mjs` in this directory, which is committed
beside them and is the only thing that has ever written them. Regenerate with:

```
node test/fixtures/media/make-fixtures.mjs
```

They exist so `test/artifactinspection.mjs` and `test/verifyapk-observation.mjs` can exercise media
inspection **without a decoder on the host and without touching a device**. A fixture is never
evidence of anything rendering: it is a container with known-good or known-broken structure.

zlib's exact compressed bytes depend on the local zlib build, so a regeneration may differ byte for
byte from what is committed. The committed files are the artifact of record; the tests assert their
*properties* (valid/invalid, dimensions, duration, track kind), never byte-equality with a rerun.

| File | Bytes | What it is | What it proves |
|---|---:|---|---|
| `valid-small.png` | 12420 | 64×64, 8-bit truecolour, non-interlaced, one filter-0 scanline per row; pixels are the deterministic pattern `((x*37+y*17), (x*53+y*101), (x*11+y*199)) mod 256` | a structurally complete PNG that is also above the capture floor (≥64×64), and whose mean luma classifies as a **lit** frame |
| `valid-dark.png` | 91 | 64×64 truecolour, every pixel `(0,0,0)` | a **valid** PNG that is **dark** — the case that must read as `inconclusive-capture-route`, never as proof that rendering failed |
| `truncated.png` | 1400 | `valid-small.png` cut at 1400 bytes, inside the IDAT chunk | a **malformed image larger than 1000 bytes**: signature and IHDR survive, the raster and IEND do not, so a size-only check would wrongly accept it |
| `arbitrary-nonempty.bin` | 1536 | `byte[i] = (i*31+7) mod 256`; no PNG signature, no `ftyp` | arbitrary nonempty bytes above the 1000-byte floor — neither image nor video |
| `valid-short.mp4` | 433 | `ftyp(isom)` + `moov(mvhd timescale=1000 duration=1500, trak → mdia → hdlr 'vide')` + `mdat` | a valid short recording container whose **measured** duration is 1.5 s and which declares one video track |
| `no-video-track.mp4` | 433 | identical structure, but the single `trak`'s `hdlr` handler type is `'soun'` | a valid container with **no video stream** — the "missing MP4 stream" case |

The high-entropy pattern in `valid-small.png` is deliberate: a uniform image compresses to ~90
bytes, and the truncation fixture has to stay above 1000 bytes to be the interesting case.

`valid-short.mp4` and `no-video-track.mp4` carry `moov` and `mdat` but no `minf`/`stbl` sample
tables. `inspectMp4` is a **container-structure** check — box nesting, exact byte coverage, `ftyp`
first, `moov`/`mdat` present, `mvhd` timescale/duration, `hdlr` handler types. It does not decode a
single frame, and `hasVideoTrack` means a video handler is *declared*, not that video plays.
