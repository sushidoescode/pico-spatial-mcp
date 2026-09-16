# Task C6 report — Correct external APK observations and inspect real media

Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-cli-2026-09-15` (branch
`track/cli050-cli`, base `23e50cc`).
Status: **DONE with one disclosure you must read first** (see "Hermeticity incident" below).
Two local commits, never pushed, tree clean.

| Commit | Subject | Files |
|---|---|---|
| `10e0372` | fix: inspect captured media before calling it evidence | `src/artifactinspection.ts` (new), `src/capture.ts`, `src/picoclitools.ts`, `test/artifactinspection.mjs` (new), `test/fixtures/media/**` (new) |
| `8b7e7a8` | fix: observe external APKs with explicit identity and no foreign-app side effects | `src/verifyapk.ts`, `src/doors.ts`, `test/doors.mjs`, `test/verifyapk-observation.mjs` (new) |

Ordered so the module lands before its consumer. Commit `10e0372` was verified to compile and pass
its own suite **standalone**, from a `git archive` of that exact commit into a scratch tree
(`tsc --noEmit` exit 0; `node --test test/artifactinspection.mjs` → 22/22), not merely asserted
from the dependency direction.

---

## HERMETICITY INCIDENT — a third one happened, in my RED phase. Disclosing it in full.

**What happened.** The first RED run of `test/verifyapk-observation.mjs` (2026-09-15 ~13:19 local)
executed against the **pre-C6** `src/verifyapk.ts`. That implementation took no dependencies at
all: it ignored the `deps` object my test passed and used its own module-level `ADB()` plus the
hardcoded `SERIAL = "emulator-5554"`. My injected seam was therefore not in the code path, and 20
test cases each drove the real `adb` against the user's live emulator.

**What it did, established from artifacts rather than guessed:**

| Command the old code runs | Effect on emulator-5554 |
|---|---|
| `install -r <temp fixture.apk>` | the fixture "apk" is a 17-byte text file — the install failed; nothing was installed |
| `shell am force-stop com.fixture.observed` | no such package; no-op |
| **`logcat -c`** | **the device's global log buffer was cleared, ~20 times. Real and irreversible.** |
| `shell am start -n com.fixture.observed/.MainActivity` | no such activity; launch rejected |
| `exec-out screencap -p` | wrote a 2 235 758-byte frame of the user's emulator to `/tmp/pico-render/verifyapk/com.fixture.observed.png` |

**What did NOT happen, and why I can say so:** no foreign app was force-stopped. The old
incumbent-recovery block is gated on `launched && !processAlive && fullSpaceBlocked`, and `launched`
was false for every case (`am start` of a nonexistent activity returns an Error line), so that block
never ran. Nothing was installed. The emulator was not restarted, moved, resized or calibrated. No
other process was killed. The physical PICO device was never addressed (the old code names only
`emulator-5554`).

**Containment.** I deleted the stray capture I created
(`/tmp/pico-render/verifyapk/com.fixture.observed.png`); the unrelated `com.example.fixture.png`
from 07:53 is C5's and I left it. I cannot restore the cleared log buffer — that loss stands.

**Root cause, stated precisely:** *an injected seam only protects you once the implementation has a
seam.* Writing the seam into the test does nothing during the RED phase, which by definition runs
against code that does not have it. That is not a mistake specific to me; it is a structural hole in
the "inject the runner" pattern during TDD.

**The fix, committed.** `test/verifyapk-observation.mjs` now opens with a second, independent
barrier that does not depend on the implementation cooperating:

```js
const PINNED_FAKE_ADB = "/fixture/no/such/adb";
process.env.PICO_ADB = PINNED_FAKE_ADB;
clearAdbResolutionCache();
```

`src/adb.ts` fails closed on an explicit `PICO_ADB` that names no existing file and refuses to fall
back, so *any* implementation that bypasses the seam dies loudly instead of finding a real adb. The
comment in the file records why it is there so nobody deletes it. Proof it works: the same RED run,
re-executed with the barrier, dropped from **57 201 ms to 96 ms** (no device round-trips), produced
the adb refusal text, and created **no** new file in `/tmp/pico-render/verifyapk/`.

**Recommendation for the remaining tasks in this plan:** pin `PICO_ADB` to a nonexistent path at
module scope in every suite that calls a tool handler which *might* reach a device, before the RED
phase, and treat "the implementation has no seam yet" as the default assumption during RED.

---

## TDD — RED then GREEN

Order followed exactly as the brief's resolution 8: media fixtures and injected-device fail-closed
tests first, then implement.

**RED 1 — `test/artifactinspection.mjs` against the untouched tree:**

```
$ node --test test/artifactinspection.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '.../dist/artifactinspection.js' imported from .../test/artifactinspection.mjs
ℹ tests 1   ℹ pass 0   ℹ fail 1
```

**RED 2 — `test/verifyapk-observation.mjs` against the untouched `src/verifyapk.ts`,
WITH the env barrier in place (this is the re-run; the first run is the incident above):**

```
$ node --test test/verifyapk-observation.mjs
ℹ tests 20   ℹ pass 1   ℹ fail 19   ℹ duration_ms 95.7
  TypeError: Cannot read properties of undefined (reading 'installedApk')
  TypeError: Cannot read properties of undefined (reading 'status')
  AssertionError: the tripwire must fire on the first device invocation (false !== true)
  ... (barrier proof: 1 occurrence of "names no existing file"; 0 new files in /tmp/pico-render)
```

The single pass was the "no capture written to the old mutable /tmp path" case, which the barrier
made vacuously true — it is a real case once the implementation exists.

**GREEN (after `npm run build`):**

```
$ node --test test/artifactinspection.mjs test/verifyapk-observation.mjs
ℹ tests 43   ℹ pass 43   ℹ fail 0
```

Two intermediate reds worth recording, both of which corrected the TEST rather than the code:

1. `assert.equal(lit.meanLuma, 255)` failed with `254.99999999999997`. The Rec.709 coefficients do
   not sum to 1 in binary floating point; the test was asserting the rounding, not the brightness.
   Replaced with a `1e-6` tolerance and a comment saying why.
2. My first draft of the reboot/PID-restart fixtures queued more scripted responses than the
   implementation actually reads. I fixed the fixtures to the real read counts (two `boot_id` reads
   bracketing the observation; two `pidof` + two `/proc/<pid>/stat` reads) and **split** the restart
   case into two, because with a changed PID the start-ticks branch is never reached — so "PID
   reuse is not continuity" now has its own case.

---

## What was implemented

### `src/artifactinspection.ts` (new, 397 lines) — pure media inspection

Reuse, not duplication: `src/evidence.ts` already owns the repository's PNG container validator
(signature, per-chunk CRC32, IHDR sanity, PLTE/IDAT ordering, bounded IDAT inflate, filter-byte
check, IEND, no trailing bytes). `inspectPng` here calls `evidence.inspectPng` for structure and
`evidence.validateCaptureBuffer` for the evidence floor, then adds only what is missing.

| Export | Returns | Notes |
|---|---|---|
| `inspectPng(bytes)` | `{valid, width, height, bitDepth, colorType, bytes, sha256, meetsCaptureFloor, captureFloorReason?, reason?}` | Container validity and *evidence-worthiness* are separate answers. An 8×8 PNG is a perfectly valid PNG and is not a scene capture; collapsing the two is how an icon becomes "the frame I looked at". |
| `inspectMp4(bytes)` | `{valid, durationSec, hasVideoTrack, trackCount, handlerTypes, bytes, sha256, reason?}` | ISO-BMFF box walk that must **exactly cover** the file, `ftyp` first, `moov` and `mdat` both present, 64-bit `largesize` and `size==0` handled, `mvhd` v0/v1 timescale+duration → measured seconds, `hdlr` handler type per track. Documented as a *container* check: it decodes no frame, and `hasVideoTrack` means a video handler is **declared**. |
| `classifyFrame(bytes, decoder?)` | `{status: dark\|lit\|undecodable\|unvalidated, valid, verdict, meanLuma, width, height, reason, note?}` | Injectable decoder seam; otherwise a built-in pure-JS PNG raster decode (non-interlaced, bit depth 8/16, colour types 0/2/4/6, bounded at 32 M pixels). Anything outside that → `unvalidated`, explicitly "nothing decoded this", never a default success. |
| `sha256Bytes(bytes)` / `sha256File(path)` | hex / `{sha256, bytes}` or `{sha256: null, reason}` | `sha256File` streams in 1 MiB chunks and reports its reason rather than throwing. |
| `DARK_FRAME_NOTE` | const | One shared sentence so no caller can quietly upgrade a dark frame into a verdict. |

A dark frame is `verdict: "inconclusive-capture-route"`. A test asserts the serialized result never
matches `/render(ing)? (failed|failure)/i`.

### `src/verifyapk.ts` (rewritten) — external-APK observation

`registerVerifyApkTools(server, deps?)` where `deps` is the device/IO seam: `runTextFn`,
`runBinaryFn`, `resolveAdbFn`, `sleepFn`, `nowFn`, `runIdFn`, `retainFn`, `observationRoot`,
`readPublishedDigestFn`, `frameDecoder`. Every device step is wrapped so a failure becomes a
structured field, never a throw.

Result scope is `external-apk-observation`, `schemaVersion: 1`, with a `notAReceipt` field stating
it carries no build provenance, no AppSpec, no signing inspection and no promotion identity. It
publishes no run receipt and writes nothing to the ledger. Reused from `src/nativefleetreceipt.ts`
(imports, no duplication): `parseInstalledApkPath`, `parsePid`, `parseProcStartTicks`,
`parseForegroundActivities`. No export was added to `nativefleetreceipt.ts` or `ledger.ts` — every
helper C6 needed was already exported, so those files are **untouched**.

Identity fields are `{status:"observed", ...}` or `{status:"missing", reason}`; a missing field
carries no value, so nothing can be read back as a caller-supplied claim:

| Field | Source |
|---|---|
| `identity.apk` | local bytes, streamed sha256 + size |
| `identity.serial` | the required input; **no default** |
| `identity.installedPackage` | `pm path <pkg>` resolving to exactly one base APK |
| `identity.installedApk` | `toybox sha256sum <that exact path>` |
| `identity.bootId` | `/proc/sys/kernel/random/boot_id`, read before and after |
| `identity.process` | `pidof` + `/proc/<pid>/stat` field 20 |
| `identity.foreground` | `dumpsys activity activities`, every resumed activity |
| `capture.route` / `capturedAt` / `sha256` / `artifactPath` | `adb-screencap`, observation clock, captured bytes, published path |

**Logs.** `logcat -d --pid=<pid> -t 2000` when a PID was observed, else `logcat -d -t 2000`. The
global log is **never** cleared. Flags verified against the AOSP `logcat` help text
(`system/logging/logcat/logcat.cpp`, `main` branch): `-d Dump the log and then exit (don't block).`,
`-t N Print most recent <count> lines (implies -d).`, `--pid=PID Only print logs from the given
pid.`. The `developer.android.com/tools/logcat` page does **not** document these individually and
says to consult the device's own `adb logcat --help` — which I did not run, because it executes on
the device. I chose PID scoping over the `-t <TIME>` form deliberately: the documented time formats
are `'MM-DD hh:mm:ss.mmm…'`, `'YYYY-MM-DD hh:mm:ss.mmm…'` or `'sssss.mmm…'` (not ISO-8601), which
would need the device's own clock and timezone, and PID scoping is strictly better for attribution
anyway. `src/workflow.ts:409` already uses `--pid` in this repository.

**Crash attribution.** A `FATAL`/`ANR in`/`Fatal signal` marker counts as this package's crash only
if the package name or the observed PID appears within 10 lines of the marker, or if the stream was
`--pid`-scoped. An unattributed global marker returns `attributed: false` **with the reason**, and a
log that could not be read returns `attributed: null` — unknown is not "no crash".

**Run directories.** `retainPicoCliObservation` (picocli.ts, C3's writer) under
`<managedRoot>/observations/external-apk-observation/<runId>/`: `wx` + fsync, non-recursive mkdir,
replacement refused. The bounded log is the retained `stdout.txt`, the frame is `capture.png`, and
the full observation record is the retained `observation.json` metadata. The mutable
`/tmp/pico-render/verifyapk/<package>.png` path is gone.

### `src/capture.ts`

`capture_frame` now refuses bytes that are not a structurally complete image instead of writing
them, refuses a valid image below the capture floor, reports dimensions and digest in its note, and
appends `DARK_FRAME_NOTE` when the frame is dark. The module doc and the tool description were
corrected: the old text generalised one 2026-06-14 observation ("this path returns the composited
HMD/immersive view and is byte-stable") into a property of the route. It now says what the route
observes — the current display through the device shell — and that black is inconclusive about the
route in both directions.

### `src/picoclitools.ts` — `capture_record` validation only

New exported pure helper `inspectRecordingArtifact(path)` → `{media, sha256, bytes,
measuredDurationSec, hasVideoTrack, trackCount, reason}`. Over 256 MB the file is hashed but not
parsed (`unvalidated` with the budget named); unreadable → `unvalidated`; unparseable container →
`invalid`, which makes the tool's `status` `failed` rather than `ok`-with-bytes.

The result now carries `requestedDurationSec` and `measuredDurationSec` **side by side** plus a
`durationNote` saying the CLI's own returned duration is the clamped request, not a measurement.
The 180-second MCP cap and the 15-second default are unchanged, and a test asserts both plus the
absence of any `1800` in the file. `RECORD_HONESTY` was corrected (it claimed the tool checks only
for a nonempty regular file) while preserving all five substrings `test/picocli.mjs` pins.

### `src/doors.ts` — descriptions and wiring only, hunks local

`pico_verify_app` gains required `serial` and optional `activity`, forwards them, and its
description no longer claims a "calibrated-eye judgment" the inner tool never performed. `pico_look`
states what the screencap route observes. Both stay on C5's raw forwarding lane; no tool was added,
removed or renamed (18 doors tools, tarball M6/M7 unaffected).

---

## Fail-closed matrix (every row is an injected-device test)

| Condition | `status` | `capture.status` | Also asserted |
|---|---|---|---|
| clean run | `observed` | `captured` | every identity field `observed`; artifact on disk hashes to `capture.sha256` |
| installed digest ≠ local APK | `mismatch` | `unavailable` | **zero** `am start`/`monkey` calls |
| foreign app in foreground | `conflict` | `not-attributable` | no command ever addresses the incumbent; `conflict.evidence` is the dumpsys tail |
| boot id changed | `inconclusive` | not `captured` | reason names the boot change |
| PID changed | `inconclusive` | not `captured` | reason matches `/PID changed/` |
| start ticks changed, same PID | `inconclusive` | not `captured` | reason matches `/start identity changed/` |
| published bytes substituted | `tampered` | `tampered` | fixture retainer verified to have written the other bytes |
| malformed image > 1000 bytes | `invalid-media` | `invalid` | honest byte count survives the refusal |
| arbitrary nonempty bytes | `invalid-media` | `invalid` | |
| screencap failed | `inconclusive` | `unavailable` | never `ok`/`observed` |
| valid **dark** frame | `observed` | `captured` | `frame.verdict === "inconclusive-capture-route"`; no rendering-failure wording |
| `pm path` unresolvable | `inconclusive` | — | field is `missing` **with no value key** |
| unattributed global FATAL | — | — | `logs.crash.attributed === false` with reason |
| FATAL naming the package | `inconclusive` | — | attributing lines returned as the evidence |
| logcat read failed | — | — | `logs.crash.attributed === null` (unknown ≠ false) |
| no serial supplied | `failed` | `unavailable` | **zero** device commands |
| `PICO_ADB` names no file | `failed` | `unavailable` | refusal precedes every spawn (tripwire list empty) |
| working resolver, runner throws | not `observed` | — | tripwire proven able to fire |

---

## Hermeticity of the new tests — how, not just claimed

* **Barrier 1**: every device interaction goes through `runTextFn`/`runBinaryFn`. The fake is a
  *model* of a device: an argv it does not recognise **throws** (`fixture reached an UNMODELLED
  device command`), so a new production command cannot slip through unobserved.
* **Barrier 2**: module-scope `PICO_ADB` pinned to a nonexistent path (see the incident above).
* Every fake asserts `args[0] === "-s"` and `args[1] === <fixture serial>` — a command addressed
  anywhere else fails the test.
* Serials are `fixture-observe-000N` / `fixture-doors-<pid>` / `fixture-lane-0001`. Never
  `emulator-5554`, never a real serial.
* Run directories are per-test `mkdtemp` roots, removed in `test.after`. Never `~/.pico-mcp`.
* The seam is asserted *used*, not assumed: call-log assertions, plus a "the loud-runner fixture
  would actually catch a spawn" case (the toolchain-cache pattern) proving the tripwire fires.
* `test/doors.mjs`'s stub adb is itself a tripwire: `exit 97` on a log-clear, `exit 98` on a missing
  serial, `exit 96` on an unmodelled command, and it records every force-stop target — so "no
  foreign app was stopped" is read out of what the stub saw, not inferred from the source.
* `test/artifactinspection.mjs` asserts textually that `dist/artifactinspection.js` contains none of
  `child_process`, `spawn`, `execFile`, `adb`, `ffprobe`, `magick`, `emulator-`.
* The reserved-serial / mutable-path / log-clear assertions run against **both** `src/verifyapk.ts`
  and `dist/verifyapk.js`, because `tsc` erases a doc comment attached to an erased type
  declaration — a dist-only check can pass for a reason unrelated to the code.
* Force-stop discipline is checked over **every** `"force-stop", <ident>` occurrence in the source,
  not one matching line, because the old defect was a *second* force-stop.
* `pgrep -fl "<worktree>/dist/index.js"` after the full run: **0** lingering children.

No host decoder is used by any test (`magick` is on this host's PATH and is never invoked;
`ffprobe` availability was never tested because nothing needs it).

---

## Media fixture provenance

Generated by the committed `test/fixtures/media/make-fixtures.mjs`; provenance and the exact
construction of each file are in `test/fixtures/media/README.md`. **None is a device capture.**
zlib's compressed bytes vary by build, so the tests assert fixture *properties*, never byte-equality
with a regeneration.

| File | Bytes | sha256 (first 16) | Role |
|---|---:|---|---|
| `valid-small.png` | 12420 | `457aadfa7d45e845` | valid 64×64 truecolour, above the capture floor, classifies **lit** |
| `valid-dark.png` | 91 | `d4270cb3908ae3f7` | valid 64×64 all-black → `inconclusive-capture-route` |
| `truncated.png` | 1400 | `13af9cfd62c85b24` | malformed **above 1000 bytes** (cut inside IDAT) |
| `arbitrary-nonempty.bin` | 1536 | `0f796e889710c211` | neither image nor video, above the floor |
| `valid-short.mp4` | 433 | `47f26ccc2b136e90` | 1.5 s measured from `mvhd`, one `vide` track |
| `no-video-track.mp4` | 433 | `7ff541ef836a141d` | valid container, only a `soun` track |

---

## Tests and results (at `8b7e7a8`, after `npm run build`)

| Command | Result |
|---|---|
| `node --test test/artifactinspection.mjs test/verifyapk-observation.mjs` | **43 / 43 pass, 0 fail** |
| `npm run test:doors` | **Doors test done. Failures: 0** |
| `npm run test:runreceipt` | **336 / 336 pass, 0 fail** |
| `npm run test:ledger` | **Ledger fixture test done. Failures: 0** |
| `npm run test:picocli` | **157 / 157 pass** + `pico-cli lane test done. Failures: 0` |
| `npm run test:prompts` | **3 / 3 pass, 0 fail** |
| `node --test test/toolchain-cache.mjs` (S4's, not in any script or workflow) | **32 / 32 pass** |
| `npm run test:docsmeta` | **Failures: 0** (162 links across 72 files) |

**Pre-existing failures, unchanged by C6** — I verified I touched none of the files involved
(`git status` shows no change to `package.json`, `gates.yml`, `README.md`, `docs/COLLABORATORS.md`,
`src/knowledge.ts`):

* `npm run test:lint` → 3 failures: `test:runrevision` declared but never run by `gates.yml`
  (the gap AGENTS.md documents), and README/COLLABORATORS claiming 47 invocations / 46 suites while
  package.json + gates.yml say 49 / 48.
* `npm run test:distribution-adoption` → 2 failures, the same 47/46-vs-49/48 drift.
* `npm run test:tarball` → 1 failure: `payload MISSING: data/ — the built code resolves it`. `data/`
  exists in the tree, `src/knowledge.ts` and others resolve it, and `package.json` `files` does not
  list it. This is a gap left by the S-track knowledge-server work, not by C6.

---

## New test files needing CI registration

Neither is wired into `package.json` or `gates.yml` — I am not permitted to edit either:

```
node --test test/artifactinspection.mjs
node --test test/verifyapk-observation.mjs
```

Suggested single script (matching the repo's grouping style):

```json
"test:observation": "node --test test/artifactinspection.mjs test/verifyapk-observation.mjs"
```

Adding it also moves the `test:` script/suite counts, which already disagree with README and
docs/COLLABORATORS — whoever registers it should fix the counts in the same change, or the lint and
distribution-adoption gates gain a fourth and third reason to be red.

---

## What stays open for native LOOK acceptance

**Nothing in this task was verified on a device, and none of it should be read as acceptance.**

* No frame produced by the new observation path has been LOOKed at. Every capture exercised here is
  a synthesised fixture; `test/doors.mjs` feeds the existing `golden/showcase-6cards.golden.png`
  through a stub adb, which proves plumbing, not rendering.
* The new `logcat -d --pid=<pid> -t <N>` invocation has **not** been run against a real device. The
  flags are verified against AOSP's help text; that they behave as documented on PICO OS 6's logcat
  build is unconfirmed.
* `toybox sha256sum` on the installed base APK is likewise documented-and-modelled, never executed
  on a device in this task. If PICO OS 6's shell lacks `toybox sha256sum`, the installed-digest
  field degrades to `missing` with the command's own error — fail-closed, but the degradation path
  is untested live.
* `mismatch`, `conflict`, `tampered` and the continuity breaks have been proven against an injected
  device only. Their *real* triggering conditions are untested.
* The dark-frame classification has never been run on an actual immersive capture.
* `capture_record`'s MP4 inspection has not seen a recording produced by the real CLI; the fixture
  harness writes no artifact in success mode, so no existing suite exercises a successful
  `capture_record` end to end.

Recommended first native step, when the emulator is free and the gates admit it: one
`verify_pico_apk` against a known-good APK with an explicit serial, then **read** the published
`capture.png`, then `record_verification` with what you actually saw.

---

## Self-review

**Completeness** — every brief checkbox: injected-device tests for all five named conditions ✓
(plus five more); the incumbent-killing doors fixture replaced by the protected default with
conflict evidence ✓; explicit toolchain/serial selection with the legacy path and mutable `/tmp`
output removed, unique run directories that refuse replacement ✓; all six media fixtures with
format/dimension/hash/measured-duration checks and an `unvalidated` no-decoder path ✓; 180 s cap and
short default kept, no 30-minute recording anywhere ✓; ledger byte-checks reused without broadening
evidence tiers ✓; descriptions updated for what each route observes ✓; build + all named suites run
✓; native LOOK left explicitly open ✓. Controller resolutions 1–8: all followed.

**Discipline** — no evidence tier was broadened; no tier name was even touched. No fleet receipt,
promotion or ledger write is reachable from this path. `src/nativefleetreceipt.ts` and
`src/ledger.ts` are byte-for-byte unchanged (every helper needed was already exported).
`src/eye.ts`, `src/adb.ts`, `src/toolchain*.ts`, `src/vault*.ts`, `src/knowledge.ts`, `src/perf*.ts`,
`src/innerclient.ts`, `package.json`, `.github/**`, `scripts/**` and
`test/distribution-adoption.mjs` untouched. The byte-pinned pico-cli policy block was not edited,
quoted or paraphrased. `src/eye.ts` needed no change: S4 had already moved it to `adbExecutable()`,
contrary to the brief's base-line note.

**Quality** — one module per concern; `doors.ts` limited to two local hunks; `evidence.ts`'s
validator reused rather than reimplemented.

**Discipline greps** (final state): no log-clear invocation in any C6 source; every `force-stop` in
`src/verifyapk.ts` targets `packageName`; `emulator-5554`, `/tmp/pico-render` and the log-clear
literal appear in C6 files only inside comments that describe their removal or assertions that they
are absent. Remaining `emulator-5554` occurrences in `test/doors.mjs` are C5's untouched
`pico_look`/`pico_emulator` lane fixtures.

## Concerns

1. **The cleared logcat buffer is real and unrecoverable.** Flagged above in full. If the user was
   mid-investigation on emulator-5554 around 13:19 today, that log content is gone.
2. **Consumer-visible result migration.** `verify_pico_apk` no longer returns `status: "ok"` /
   `attention` / `installed` / `launched` / `processAlive` / `crashed` / `artifact` at the top level;
   it returns the observation record. `pico_verify_app` now **requires** `serial`. Any caller or
   prompt outside the repo that reads the old shape will break. I found no other in-repo consumer
   (`grep` across `src/` and `test/`: only `doors.ts` and the two suites).
3. **`capture_frame` and `capture_record` still default to `emulator-5554`.** I deliberately left
   both: the audit finding was the *external-APK* path, and removing those documented defaults is a
   breaking change to many lanes well outside C6's brief. They are the remaining "acts on a device
   the caller never named" surface, and worth a follow-up task.
4. **`inspectMp4` accepts a container with no `minf`/`stbl`.** My fixtures are deliberately minimal.
   This is documented in the module and the README as a container-structure check, not a conformance
   validator — but it does mean `media: "validated"` is a weaker statement than it sounds.
5. **Foreign-foreground detection uses the first resumed activity** when ours is absent. On a device
   reporting several resumed activities across displays, the "foreground package" named in a
   conflict is one of them, not necessarily the blocking one. All parsed activities are returned in
   `identity.foreground.activities` so the caller can see the rest.
6. **Two suites remain unregistered in CI** (above), and `test/toolchain-cache.mjs` — S4's suite —
   is also in no script and no workflow. Three suites can currently regress invisibly.

---

# Fix round 1 (of 5) — three Important findings

Commit `1d2e23d` — `fix: inspect canonical captures, close the observation ladder and require
explicit capture targets`, trailer present, never pushed, tree clean. All test runs below were made
with `PICO_ADB=/fixture/no/such/adb` exported in the shell, in addition to the module-scope barrier
inside `test/verifyapk-observation.mjs`.

## Finding 1 — `pico_look`'s description claimed an inspection its route did not perform

`src/eye.ts` `capture_canonical` gained the same `inspectPng` gate `capture_frame` has: invalid or
truncated bytes return a structured failure and **nothing is written**; a valid image below the
capture-evidence floor is refused the same way. The result now also carries `width`/`height`, and
the tool's own description states the inspection. The hunk is 9 lines plus one import; the serial
and output path of `capture_canonical` are untouched, per the ruling that this round's ownership
there covers validation only.

This matters more in `capture_canonical` than anywhere else: the canonical frame is what the
returned `sha256`, the `MATCH`/`DRIFT` verdict, `analyzeFrame`'s measurements and every ledger claim
citing "the canonical capture" are all anchored to. A byte count was never an inspection.

**The existing fixture was part of the defect.** `test/eye.mjs`'s "binds RECENTER and screencap to
one requested serial" case fed `Buffer.alloc(1200, 7)` — 1200 bytes of constant `7`, which is not an
image in any format — and passed only because the gate was `length < 1000`. It now feeds the
committed `valid-small.png` and additionally asserts the reported dimensions. The new case feeds
`truncated.png` (1400 bytes, above the old floor) and asserts `isError`, the refusal text, and that
the output file does **not** exist:

```
ok   capture_canonical binds RECENTER and screencap to one requested serial
ok   capture_canonical reports the inspected frame's real dimensions
ok   capture_canonical refuses a malformed >1000-byte screencap and writes nothing (1400 bytes)
```

## Finding 2 — the status ladder was fail-open on three identity/evidence gaps

Three branches added to `src/verifyapk.ts`, each carrying the **existing `missing()` reason text**
rather than a paraphrase (asserted by the tests):

| Gap | New status | Why it is not "observed" |
|---|---|---|
| `identity.bootId` missing | `inconclusive` | without a boot identity nothing below is pinned to one device run — continuity was never *established*, as distinct from established and unbroken |
| `identity.foreground` missing | `inconclusive` | "our app was in front" was never observed, which is exactly the gap a foreign foreground would also occupy |
| `crash.attributed === null` | `inconclusive` | the log could not be read, so the observation cannot say the app ran without crashing. Unknown is not "no crash" |

Isolating the bootId case needed a device model that can fail *one* read: `bootIds: [null, BOOT_ID]`
fails only the first, so there is no continuity **break** to report and the new branch is what the
ladder actually reaches. With both reads failing, the pre-existing continuity branch fires first and
the new branch would never have been exercised. `foregroundPackages: [null]` models a dump naming no
resumed activity, and the test additionally asserts no `conflict` key — "nothing resumed" and "a
foreign app resumed" are different findings.

Three new tests plus a status assertion added to the existing log-failure case:

```
ok   a boot identity that was never observed is INCONCLUSIVE, not a clean observation
ok   a foreground that was never observed is INCONCLUSIVE — the frame is unattributable
ok   an UNKNOWN crash state is INCONCLUSIVE — unknown is not 'no crash'
ok   a log read that fails leaves logs unavailable and never implies 'no crash'   (+ status assertion)
```

## Finding 3 — explicit capture targets and run-unique output paths

`capture_frame` (`src/capture.ts`) and `capture_record` (`src/picoclitools.ts`) now **require** their
target and refuse with a structured error naming the missing input. Both refusals happen **before**
anything is resolved — `capture_frame` returns before `resolveAdb()`, `capture_record` before
`ensurePicoCli()` — so a call with no target performs no adb resolution, no registry lookup, no
provisioning and no managed-store write. Both defaults are now run-unique under the observation root
(`<observationRoot>/capture-frame/<runId>/capture_frame.png`,
`<observationRoot>/capture-record/<runId>/recording.mp4`) instead of `/tmp/pico-render/capture_frame.png`
and a wall-clock name in one shared `~/.pico-mcp/recordings` directory, where two recordings started
in the same millisecond collided and nothing tied a file to its run.

Parameter naming: `capture_record`'s input is `device`, not `serial`. I made `device` required rather
than renaming it, because a rename is a breaking change to every existing caller and the ruling's
substance — an explicit, non-defaulted target — is satisfied either way. Flag it if you want the
rename.

**Callers.** `grep` over `src/` found **no** programmatic invocation of either tool; every hit is
prose in a description, prompt or note. The only programmatic capture call in `src/` is
`doors.ts:495` → `capture_canonical`, whose schema I did not change. The two permitted next-step
hint strings (`src/unitybuild.ts:112`, `src/unitygen.ts:195`) now tell the reader to pass a serial.
Three `capture_record` fixtures in `test/picocli-autoinstall.mjs` now pass `device: "fixture-record-0001"`
— a fixture serial, never `emulator-5554`.

Two new tests, both exercising only the **refusal** path, deliberately: neither tool takes an
injectable runner, so calling either *with* a target would reach the real one. The refusal path
cannot reach a device even by accident.

```
ok   capture_frame refuses to capture without an explicit serial, before resolving adb
ok   capture_record refuses to record without an explicit device, before any CLI work
```

`capture_record`'s case asserts the absence of the `picoCli` provenance key as evidence the refusal
came first, since that key only ever appears after a successful ensure.

## Commands and output

```
$ npm run build                                                  (tsc, exit 0)

$ node --test test/artifactinspection.mjs test/verifyapk-observation.mjs
ℹ tests 48   ℹ pass 48   ℹ fail 0          (was 43; +3 ladder, +2 explicit-target)

$ npm run test:doors            Doors test done. Failures: 0
$ npm run test:eye              Eye calibration test done. Failures: 0
                                USD render producer test done. Failures: 0
$ npm run test:picocli          pico-cli lane test done. Failures: 0
                                ℹ tests 157   ℹ pass 157   ℹ fail 0
$ npm run test:prompts          ℹ tests 3   ℹ pass 3   ℹ fail 0
$ npm run test:unitygen         Unitygen test done. Failures: 0
```

## ONE NEW FAILURE I COULD NOT FIX — it is in a file I may not edit

`test/distribution-adoption.mjs` goes from 2 failures to **3** as a direct, unavoidable consequence
of finding 3. Line 720 invokes `capture_record` with no target:

```js
["capture_record", { durationSec: 1, outputPath: path.join(harness.root, "capture.mp4") }],
```

and the enclosing test asserts `failureClass === "setup-required"`. It now gets the refusal:

```
AssertionError: registry latest/capture_record: {"status":"failed","failureClass":"runtime",
  "note":"device is required: capture_record names the device the recording came from, and there is
  no default target. Pass the adb serial of the device to record."}
```

**One-line fix, for whoever owns that file:** add `device: "fixture-record-0001"` to that
invocation, exactly as I did at the three `test/picocli-autoinstall.mjs` sites.

There is no way to both require an explicit target and keep that assertion green. The only
alternative would have been to give the missing-target refusal `failureClass: "setup-required"` so
the test passes — i.e. to mislabel the failure class to keep a gate quiet. I did not do that.

A **fourth** failure appears in that suite (`preflight prints the verified emulator-bundle install
route but never runs it`, asserting `fail` and getting `{"status":"unknown","detail":"cannot check
without adb"}`) but it is **induced by the `PICO_ADB` pin itself**, not by any code change, and will
not appear in CI. I did not run that suite unpinned, because doing so would let `preflight_env`
probe the real adb — precisely what the hermeticity rule forbids me from doing on this host.

## Routed to the final checkpoint task (not edited, per the ruling)

* `docs/DEVICE_VERIFICATION.md` — two lines are now false, quoted exactly:
  * `:151` — ``| `capture_frame` | Accepts `serial` (defaults to `emulator-5554`); …``. There is no
    default any more.
  * `:157` — ``| `verify_pico_apk` | Currently hardcodes `emulator-5554`; it cannot target hardware.``
    It no longer hardcodes anything, and requiring an explicit serial is precisely what lets it
    target hardware — so this line now understates the tool.
  * `:65` is a raw-adb shell recipe writing to `/tmp/pico-render/swan-capture.png`. That is the
    reader's own `adb` command, not a tool default, so it is **not** contradicted by this change —
    I checked rather than assuming.
* `docs/claims/claims.json` — **historical attestations, to be preserved, not rewritten.** Eight
  entries mention `verify_pico_apk`; they describe the old result shape verbatim (`status=ok`,
  `processAlive`, `captureWarning`), and one explicitly credits the behaviour this task removed:
  *"Clears logcat before launch so the crash scan is scoped to this run (reviewer-caught fix)."*
  Those were true when recorded and are evidence of what was observed then; the global constraint is
  to preserve prior evidence. The contradiction is only that a reader consulting them today finds a
  tool description that no longer matches. My recommendation for the checkpoint is a dated note
  elsewhere pointing at the change, **not** an edit to the recorded claims. The `/tmp/pico-render/…`
  strings in that file are likewise historical capture paths inside attestations, not a current
  default.

  (An earlier draft of this report asserted these claims were "tied to the fixed capture path"
  before I had read them. I checked, and that framing was wrong; this is the corrected version.)
* Also worth the checkpoint's attention: `capture_canonical`'s own default serial
  (`emulator-5554`) and default output path (`/tmp/pico-render/canonical.png`) survive, because this
  round's ownership there was validation-only. They are the last two instances of the pattern
  findings 3 removed everywhere else, and `pico_look` — the door most agents actually use — goes
  through exactly that tool.

## Untouched

No ledgered Minor item was addressed. `src/nativefleetreceipt.ts`, `src/ledger.ts`, `src/adb.ts`,
`src/toolchain*.ts`, `src/vault*.ts`, `src/knowledge.ts`, `src/perf*.ts`, `src/innerclient.ts`,
`package.json`, `.github/**`, `scripts/**`, `test/distribution-adoption.mjs` and every doc remain
unmodified. Evidence tiers were not touched. No lingering child processes after any run; no new file
in `/tmp/pico-render/`.
