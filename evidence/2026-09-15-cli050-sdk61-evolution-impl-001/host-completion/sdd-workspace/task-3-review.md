# Task 3 review — Artifact preservation: no replacing rename, unique retained LOOK captures

Base `070e4a8` → Head `8956eae`. Reviewed the brief, the report, and the full diff
(`review-070e4a8..8956eae.diff`); spot-checked the current worktree files at the cited lines for
claims the diff context alone couldn't settle (temp-file naming convention, `HOME` resolution
chain, dead-reference sweep, existing outPath coverage).

## Spec Compliance

- ✅ Spec compliant

**Gap 1 — `land()` fails closed (`scripts/publish-tarball.mjs`)**
- `land()` (`scripts/publish-tarball.mjs:160-176`) now tries only `ops.link()`. `EEXIST` →
  unchanged `occupiedError` (line 162). Any of the six `LINK_UNSUPPORTED` codes
  (`scripts/publish-tarball.mjs:49`, unchanged set) → a refusal `Error` with
  `code: "PUBLISH_NO_ATOMIC_PUBLICATION"` (line 172) and `cause` set to the original errno error
  (line 173). Anything else rethrows untouched (line 175). No rename ever runs: `PUBLISH_IO`
  (`scripts/publish-tarball.mjs:57-66`) has no `rename` key at all, and `grep -n "\.rename("` over
  the file returns nothing — a test cannot make one run even by injection.
- The staged temporary is still removed on refusal: `land(...)` is called inside the `try` at
  `scripts/publish-tarball.mjs:209`, and `finally { removeTemporary(temporary.path, ops); }` at
  line 210-212 wraps it — confirmed by reading `publishVerifiedTarball` directly, since this
  wiring sits outside the diff's hunks.
- `EEXIST` still refuses an occupied destination: unchanged, and the pre-existing test "refuses to
  replace an existing artifact, and the prior bytes and directory listing do not move"
  (`test/publish-tarball.mjs:94`) passes untouched in every RED/GREEN log.
- Tests: `test/publish-tarball.mjs:183` flips the old fallback test into a refusal test using the
  brief's four binding assertions verbatim (no rename runs, nothing lands, the staged copy is
  removed, `PUBLISH_NO_ATOMIC_PUBLICATION` + `/hard link/i` message); `test/publish-tarball.mjs:219`
  adds full six-errno coverage (`EXDEV, EPERM, ENOSYS, EOPNOTSUPP, ENOTSUP, EMLINK`), matching
  `LINK_UNSUPPORTED` exactly, and asserts `error.cause?.code` survives per code.
- RED→GREEN evidence is real: `step2-red-publish-tarball.log` shows exactly the two new tests
  failing with "Missing expected exception" (diff lines 1730-1764); `step3-green-publish-tarball.log`
  and `step3-green-test-tarball.log` show 11/11 (diff lines 1770-1872).

**Gap 2 — unique retained LOOK captures**
- `src/capturepaths.ts:24,27` implements the brief's interface verbatim:
  `observationCapturePath(kind, fileName)` → `path.join(picoCliObservationRoot(), kind, runId,
  fileName)`, `runId = ${ISO-without-punctuation}-${randomUUID()}`. This is the same shape already
  used by `retainPicoCliObservation` (`src/picocli.ts:1101`) and `src/picoclitools.ts:542` —
  verified directly, not just asserted.
- `src/capture.ts:54` calls `observationCapturePath("capture-frame", "capture_frame.png")`, its
  private `defaultCapturePath` is gone (confirmed no residual references).
- `src/eye.ts:322-323`: `dev = serial ?? "emulator-5554"` is unchanged; `outPath ??
  observationCapturePath("canonical", "canonical.png")` replaces the old fixed-path literal.
- `src/emulatorlook.ts:80,93`: same target default unchanged; the unconditional
  `/tmp/pico-render/emulator_look.png` literal is replaced with
  `observationCapturePath("emulator-look", "emulator_look.png")`.
- `grep -n "pico-render"` across `src/capture.ts`, `src/eye.ts`, `src/emulatorlook.ts`,
  `src/capturepaths.ts` returns exactly one hit — a comment in `capturepaths.ts` describing the
  historical defect, not a live code path. No fixed host path is reachable from any of the three
  handlers any more.
- Explicit `outPath` still honoured: not just inferred — `test/eye.mjs:127` (pre-existing,
  untouched by this diff) passes an explicit `outPath` and its consuming checks at
  `test/eye.mjs:131-132` pass identically in both the RED (`step4-red-eye.log`) and GREEN
  (`step5-green-eye.log`) logs.
- Default-path tests (`test/eye.mjs:158-198`) assert: path under
  `picoCliObservationRoot()/canonical/<runId>/canonical.png`, never `/tmp/pico-render`, two calls
  retain both frames, and the fixture adb still receives `-s emulator-5554` on a default call — all
  four present and all four were RED at step 4, GREEN at step 5 (`step4-red-eye.log` /
  `step5-green-eye.log`, diff lines 1877-2051).
- `test/verifyapk-observation.mjs:550` (source-scan) and `:561` (unit test) cover `src/eye.ts`,
  `dist/eye.js`, `src/emulatorlook.ts`, `dist/emulatorlook.js` for absence of `/tmp/pico-render`,
  presence of `observationCapturePath`, and presence of `emulator-5554`; both RED at step 4
  (`step4-red-observation.log`), GREEN at step 5 (`step5-green-observation.log`, 50/50).
- Descriptions are true: `src/capture.ts` outPath description, `src/eye.ts` outPath description,
  and the `emulator_look` tool description all say "run-unique RETAINED file under the observation
  root" and, where relevant, "the default TARGET is unchanged (emulator-5554)" — matches the code
  exactly (verified above).

**Disclosed deviations from the brief's literal text — both are correct calls, not defects:**
1. The brief's `.publish-` directory filter (`test/publish-tarball.mjs:183` region) would be
   vacuously empty regardless of whether a temp file leaked, because the real staged-temp name is
   `.<basename>.<hex>.part` (verified directly: `scripts/publish-tarball.mjs:118`,
   `` `.${basename}.${crypto.randomBytes(8).toString("hex")}.part` `` — contains no `.publish-`
   substring). The implementer kept the brief's literal assertion (binding) and added
   `assert.deepEqual(fs.readdirSync(archiveDir).sort(), priorNames)`, which is the assertion that
   actually catches a leftover temp file. Correct catch.
2. Extending the exact loop at the brief's cited `test/verifyapk-observation.mjs:~532` location
   would have forced a false failure: that loop also asserts the scanned file must **not** contain
   `"emulator-5554"` (verified directly at `test/verifyapk-observation.mjs:524`, part of the
   pre-existing `verifyapk.ts` scan), which is wrong for `eye.ts`/`emulatorlook.ts`, whose
   documented default target is exactly that serial. The implementer added an adjacent, dedicated
   test (`test/verifyapk-observation.mjs:550`) instead, asserting the opposite (`emulator-5554`
   must be *present*). Correct catch.

**RED-phase host-scratch disclosure (report's Concern #1) — verified, and it cannot recur:**
The report discloses that the Step-4 RED test, before `capturepaths.ts` existed, called
`capture_canonical` with no `outPath` while `src/eye.ts` still pointed at the literal
`/tmp/pico-render/canonical.png`, overwriting that host file once. I traced this independently:
`picoCliObservationRoot()` (`src/picocli.ts:1041-1044`) resolves through
`managedHomeFromSnapshot(process.env, ...)` (`src/picocli.ts:813-825`), which reads
`process.env.HOME` live at call time. Post-fix, the default path is `HOME`-relative, and both new
tests override `process.env.HOME` to a `mkdtemp` directory before invoking the handler
(`test/eye.mjs:158-160`, `test/verifyapk-observation.mjs:561-593` region) and restore it after. Pre-fix,
overriding `HOME` had no effect because the old code (`"/tmp/pico-render/canonical.png"`) never
read `HOME` at all — which is exactly why the RED-phase call reached the real host path once. Post-fix,
`grep` confirms zero `/tmp/pico-render` references remain in any of the four touched `src/*.ts`
files, so no test — RED or GREEN, today or on a future run — can reach that literal again. The
disclosure is accurate and the risk is closed.

- ⚠️ Cannot verify from diff:
  - The exact commit message trailers (`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
    on every commit) — the diff package's commit list (`review-...diff:4-6`) shows only short SHA +
    subject line, not full messages. Per instructions I did not re-run `git log` to check this.
  - Whether `git add -f` was literally the staging mechanism for the evidence logs — the practical
    requirement (new logs land in the commit, nothing under `evidence/` modified/deleted) is
    directly confirmed by the diff itself (every `evidence/.../task-3/*.log` entry is a "new file
    mode 100644"; none is a modification or deletion), which is the outcome that matters.
  - `emulator_look`'s behavior on a real emulator/device — the report honestly flags this as
    untested beyond source-scan + shared-helper unit coverage (no qemu window, no macOS
    Accessibility, no CGEvent drag available here), consistent with this review's own no-device,
    no-emulator constraint. Structural coverage is real (`test/verifyapk-observation.mjs:550`); the
    interaction/device behavior itself remains unverified, as the report says.

## Strengths

- Root-cause fix for both gaps, not a patch: the replacing-rename fallback is removed at the
  primitive level (no `rename` left in the injectable seam at all), and the capture-path fix
  removes the shared-mutable-file pattern rather than papering over one symptom.
- The refusal carries both a human-readable reason and a preserved `cause` chain
  (`scripts/publish-tarball.mjs:172-173`), and cleanup still runs through the existing `finally`
  (independently confirmed by reading `publishVerifiedTarball`, since that wiring sits outside the
  diff's hunks).
- Both of the brief's literal-text traps (the vacuous `.publish-` filter, and the
  `emulator-5554`-forbidding loop) were caught and disclosed with correct, well-reasoned fixes
  rather than followed blindly or silently ignored.
- The RED-phase host side effect is disclosed with enough specificity (file, fixture sha256, byte
  count, timestamp, mechanism) to audit, and I was able to independently confirm both the cause and
  that it cannot recur post-fix.
- DRY: exactly one path-construction implementation now serves `capture_frame`, `capture_canonical`,
  and `emulator_look`; the old file-local `defaultCapturePath` in `capture.ts` is gone with its
  now-unused imports.
- Real tests throughout: the publish-tarball tests exercise real hard links and real filesystem
  state; the capture-path tests drive the actual registered tool handler and assert on files that
  actually landed on disk under a real `mkdtemp` HOME, not mocks of the code under test.
- Good scope discipline: the report catalogues twelve other `/tmp/pico-render` defaults
  (`cameradrive.ts`, `capturerig.ts`, `verifyvisual.ts`, etc.) left untouched, and none of them was
  touched by the diff — matches the dispatch's boundary exactly.
- Four extra "insurance" gates beyond what the brief asked for (`test:sdkselection`,
  `test:plugin-bootstrap-freshness`, `test:conformance`, `test:buildfreshness`) all ran green,
  reducing the chance of an unnoticed regression from the new `src/*.ts` file.

## Issues

#### Critical (Must Fix)

None.

#### Important (Should Fix)

None. I looked specifically for: a live path back to `/tmp/pico-render` (none — verified by direct
grep of the four touched source files), a `rename` call surviving anywhere in
`publish-tarball.mjs` (none), a caller elsewhere in the tree still expecting `PUBLISH_IO.rename`
(`grep` over `scripts/`, `src/`, `test/` found only the three already-accounted-for files), and
whether the `finally`/cleanup path still executes on refusal (confirmed by reading the caller).
None of these turned up a defect.

#### Minor (Nice to Have)

- `npm run --silent test:docsmeta` (`step5-test-docsmeta.log`, diff line 2224, and
  `final-gate-run.log`, diff line 1610) prints `WARN homepage/origin check skipped: ENOTDIR: not a
  directory, open '.../.git/config'` on every run in this checkout. This is noise worth flagging
  per review instructions, but it is a pre-existing artifact of running in a git worktree (`.git` is
  a file here, not a directory) and is unrelated to anything this diff touches — `docsmeta.mjs`
  itself reports "Failures: 0" for it.
- The run-id shape (`${ISO-without-punctuation}-${uuid}`) now exists nearly identically in three
  places: `src/capturepaths.ts:28`, `src/picocli.ts:1101`, `src/picoclitools.ts:542`. This
  pre-dates the task (the other two were untouched by this diff) and matching the existing
  convention was the right call for this task's scope, but a future pass could extract one shared
  helper.
- `test/eye.mjs:158-198`'s new default-path block doesn't wrap its `HOME` override in a
  `try`/`finally` the way the analogous new block in `test/verifyapk-observation.mjs:561-593` does.
  I confirmed this is harmless here — the file's `check()` helper never throws (RED-phase log shows
  execution continuing past three failing checks), and the mocked `runBinaryFn` cannot reject — but
  the two new blocks are stylistically inconsistent on this point.
- `docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md` records the old empty-`/tmp/pico-render/`
  leftover as "expected behaviour"; that row is now stale (per the report's own disclosure) and
  the file was deliberately left untouched to preserve incident-record history. Reasonable given
  the `evidence/`-preservation constraint's spirit, but a future pass may want a forward-pointer
  note.

## Assessment

**Task quality:** Approved

**Reasoning:** Both gaps are fixed at the root (no replacing primitive left to inject; no fixed
capture path left to overwrite), every binding assertion from the brief is present and passing
with real RED→GREEN evidence, the two places where the brief's literal text would have produced a
broken or misleading test were caught and correctly worked around with clear disclosure, and the
one real side effect (a one-time RED-phase host-scratch overwrite) is honestly reported and
independently verifiable as non-recurring. I found no correctness or maintainability issue worth
blocking on.
