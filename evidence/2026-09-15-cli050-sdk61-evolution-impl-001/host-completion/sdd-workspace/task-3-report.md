# Task 3 report — Artifact preservation: no replacing rename, unique retained LOOK captures

Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-hc-t3-2026-09-16`
Branch: `hc/t3-artifact-preservation` (based on integration `070e4a8`)
Commits: `b6d8d63`, `e36cb68`

---

## What I implemented

### Gap 1 — `scripts/publish-tarball.mjs` could replace a published artifact

`land()` used to fall back, on a `LINK_UNSUPPORTED` errno, to *claim the destination name with an
exclusive create → close it → unlink it → `rename()` onto it*. Between the unlink and the rename
the name was free, and `rename()` has no non-replacing mode — a window in which a racing
publisher's artifact is silently destroyed. That is the single outcome the module exists to
prevent.

`land()` now uses `link()` and only `link()`:

- `EEXIST` → the existing `occupiedError("the artifact", …)` (unchanged).
- any code in `LINK_UNSUPPORTED` (`EXDEV`, `EPERM`, `ENOSYS`, `EOPNOTSUPP`, `ENOTSUP`, `EMLINK`) →
  a refusal `Error` with `code: "PUBLISH_NO_ATOMIC_PUBLICATION"`, a message that names hard links
  and says why rename is not used, and `cause` set to the original errno error.
- anything else → rethrown untouched.

The staged temporary is removed by the existing `finally` (`removeTemporary`), so a refusal leaves
the destination directory byte-for-byte as it was.

`rename` was also deleted from the injectable `PUBLISH_IO` seam: the module has no replacing
primitive left, so a test cannot make one run even by injection. `openExclusive` stays — it still
reserves the staged temporary.

Prose corrected (no managed-CLI policy vocabulary anywhere; `test/distribution-adoption.mjs`'s
`contradictoryManagedPolicyPatterns` list was read first and nothing I wrote touches it):

- `scripts/publish-tarball.mjs` header guarantee 4 now states the refusal and explains the window
  the old fallback had.
- the `LINK_UNSUPPORTED` comment says these codes refuse publication.
- the `PUBLISH_IO` seam comment says there is no `rename` to inject.
- `scripts/verify-tarball.mjs`'s publish `catch` comment now names the second refusal reason.

`TESTERS.md` and `README.md` were checked and describe neither the fallback nor the publication
primitive — nothing to correct there. `docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md` and
`docs/claims/*` were deliberately left untouched (preserved incident/evidence records).

### Gap 2 — the canonical and emulator LOOK captures wrote to one fixed file

`capture_canonical` (`src/eye.ts`) defaulted to `/tmp/pico-render/canonical.png` and
`emulator_look` (`src/emulatorlook.ts`) wrote unconditionally to
`/tmp/pico-render/emulator_look.png`. The second capture silently overwrote the frame the first
was still being cited for, so `record_verification`'s byte-equality re-capture could be comparing
against bytes that had already moved, and two agents capturing at once produced one file and two
claims about it.

New `src/capturepaths.ts` holds the single helper all three capture defaults now share:

```ts
export type ObservationCaptureKind = "capture-frame" | "canonical" | "emulator-look";
export function observationCapturePath(kind: ObservationCaptureKind, fileName: string): string
// -> path.join(picoCliObservationRoot(), kind, `${ISO-without-punctuation}-${randomUUID()}`, fileName)
```

That run-id shape is the same one `retainPicoCliObservation` and `capture_record` already use, so
default captures are RETAINED in the observation store rather than written to host scratch.
Naming a path creates nothing; the caller still owns the write.

- `src/capture.ts` deleted its private `defaultCapturePath` (and its now-unused `randomUUID` /
  `picoCliObservationRoot` imports) and calls `observationCapturePath("capture-frame", "capture_frame.png")`.
- `src/eye.ts` `capture_canonical` calls `observationCapturePath("canonical", "canonical.png")`; an
  explicit `outPath` still wins.
- `src/emulatorlook.ts` `emulator_look` calls `observationCapturePath("emulator-look", "emulator_look.png")`.

**The default TARGET is unchanged.** Both tools still resolve `serial ?? "emulator-5554"`, and
`test/eye.mjs` pins that the fixture adb still receives `-s emulator-5554` on a default call.
Everything else about both handlers (settle delays, recenter, PNG inspection, sips downscale,
`mkdirSync` placement, returned payload) is byte-identical.

Three descriptions updated, each truthful for its own tool:

| Tool | Description change |
| --- | --- |
| `capture_frame.outPath` | "…a run-unique **RETAINED** file under the observation root, never a fixed shared path a later capture can overwrite." (it has no default target — `serial` is REQUIRED — so no target clause was added) |
| `capture_canonical.outPath` | was "(default /tmp/pico-render/canonical.png)" → "Full-res PNG output path. Default: a run-unique RETAINED file under the observation root, never a fixed shared path a later capture can overwrite. The default TARGET is unchanged (emulator-5554)." |
| `emulator_look` (tool description; it takes no `outPath`) | appended "The frame is saved to a run-unique RETAINED file under the observation root, never a fixed shared path a later look can overwrite; the default TARGET is unchanged (emulator-5554)." |

---

## TDD evidence, step by step

| Step | Action | Result |
| --- | --- | --- |
| 1 | Replaced the "falls back to an exclusive probe and a rename…" test in `test/publish-tarball.mjs` with "refuses to publish where hard links are unavailable instead of falling back to rename"; deleted "the rename fallback still refuses an occupied destination…"; added a second test covering every `LINK_UNSUPPORTED` errno | — |
| 2 | `node --test test/publish-tarball.mjs` | **RED**, exit 1, 2 failing: "Missing expected exception" on both new tests (`step2-red-publish-tarball.log`) |
| 2 | Implemented fail-closed `land()`, removed `rename` from the seam, corrected the prose | — |
| 3 | `node --test test/publish-tarball.mjs` | **GREEN** 11/11 (`step3-green-publish-tarball.log`) |
| 3 | `npm run --silent test:tarball` | **GREEN**, "Tarball verification done. Failures: 0" (`step3-green-test-tarball.log`) |
| 3 | commit `b6d8d63` | — |
| 4 | Added four `check()`s to `test/eye.mjs` (default path under `picoCliObservationRoot()/canonical/<runId>/canonical.png`; never `/tmp/pico-render`; two calls retain both frames; fixture adb still gets `-s emulator-5554`) | — |
| 4 | `node test/eye.mjs` | **RED**, exit 1, 3 failures — the log literally shows the old path: `FAIL … (/tmp/pico-render/canonical.png)`. The 4th check (default target) passed from the start, which is the point: the target was never supposed to move. (`step4-red-eye.log`) |
| 4 | Extended `test/verifyapk-observation.mjs` with the LOOK-capture source scan + a direct `observationCapturePath` unit test | — |
| 4 | `node --test test/verifyapk-observation.mjs` | **RED**, exit 1, 2 failing (`step4-red-observation.log`) |
| 5 | Created `src/capturepaths.ts`; rewired `capture.ts`, `eye.ts`, `emulatorlook.ts`; updated the three descriptions; `npm run build` | — |
| 5 | `node test/eye.mjs` | **GREEN**, 0 failures; default path now `<tmpHOME>/.pico-mcp/cli/observations/canonical/20260916T102739904Z-ff27a289-…/canonical.png` (`step5-green-eye.log`) |
| 5 | `npm run --silent test:observation` | **GREEN** 50/50 (`step5-green-observation.log`) |
| 5 | commit `e36cb68` | — |

The two new `test/eye.mjs` and `test/verifyapk-observation.mjs` suites redirect `process.env.HOME`
to a `mkdtemp` directory before exercising a default path and restore it afterwards, so no default
capture in the test suite writes to the real home or to `/tmp/pico-render`.

---

## Tests and results (final consolidated run, `final-gate-run.log`)

`PICO_ADB=/fixture/no/such/adb` exported in every shell. HEAD `e36cb68`.

| Command | Result |
| --- | --- |
| `npm run build` | **PASS** (published 191 files for source `2246cdcfe22e`) |
| `node --test test/publish-tarball.mjs` | **PASS** — 11 tests, 0 fail |
| `npm run --silent test:tarball` | **PASS** — Failures: 0 |
| `npm run --silent test:eye` | **PASS** |
| `npm run --silent test:observation` | **PASS** — 50 tests, 0 fail |
| `npm run --silent test:doors` | **PASS** |
| `npm run --silent test:lint` | **PASS** |
| `npm run --silent test:docsmeta` | **PASS** |
| `npm run --silent test:distribution-adoption` | **PASS** |

Four further gates run as insurance, because a new `src/*.ts` file changes what several suites
enumerate — all **PASS**: `test:sdkselection`, `test:plugin-bootstrap-freshness`,
`test:conformance`, `test:buildfreshness` (`aux-*.log`).

Evidence class: **structural / fixture / host**. No device, no emulator, no rendered frame — this
task changes where a capture is written, not what it shows, so there is no LOOK claim to make.

---

## Files changed

| File | Change |
| --- | --- |
| `scripts/publish-tarball.mjs` | `land()` fails closed on `LINK_UNSUPPORTED`; `rename` removed from `PUBLISH_IO`; header guarantee 4, `LINK_UNSUPPORTED` and seam comments corrected |
| `scripts/verify-tarball.mjs` | publish `catch` comment names the second refusal reason (comment only) |
| `test/publish-tarball.mjs` | rename-fallback test flipped to a refusal test; occupied-destination rename test deleted; per-errno refusal test added |
| `src/capturepaths.ts` | **new** — `observationCapturePath(kind, fileName)` |
| `src/capture.ts` | private `defaultCapturePath` deleted; uses the shared helper; `outPath` description |
| `src/eye.ts` | `capture_canonical` default path + `outPath` description |
| `src/emulatorlook.ts` | `emulator_look` output path + tool description |
| `test/eye.mjs` | four default-path/default-target checks |
| `test/verifyapk-observation.mjs` | LOOK-capture source scan (src + dist, both modules) + `observationCapturePath` unit test |
| `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-3/*.log` | run logs (added with `git add -f`) |

---

## Out-of-scope `/tmp/pico-render` defaults still present (for controller disclosure)

Deliberately untouched per the dispatch. Each of these still defaults to a fixed, shared,
non-retained host path, so the same overwrite hazard remains for them:

| Source | Line | Default |
| --- | --- | --- |
| `src/cameradrive.ts` | 718 | `capture_orbit` → `/tmp/pico-render/capture_orbit.png` |
| `src/cameradrive.ts` | 757 | multiview → `/tmp/pico-render/multiview` |
| `src/capturerig.ts` | 74 | rig frames → `/tmp/pico-render/rig` |
| `src/verifyvisual.ts` | 48 | `verify_visual` → `/tmp/pico-render/verify_visual` |
| `src/verifybaseline.ts` | 34 | baselines → `/tmp/pico-render/baselines` |
| `src/virtualcamera.ts` | 123–124 | vcam → `/tmp/pico-render/vcam`, `/tmp/pico-render/vcam/from-app` |
| `src/splatanalyze.ts` | 256 | splat heatmap → `/tmp/pico-render/splat` |
| `src/semanticsplat.ts` | 154 | semantic splat → `/tmp/pico-render/semantic/<stem>` |
| `src/hybridbuild.ts` | 127 | hybrid shots → `/tmp/pico-render/hybrid/<dir>` |
| `src/fleetbuild.ts` | 1175 | fleet shots → `/tmp/pico-render/fleet/<id>` |
| `src/webspatialmv.ts` | 212 | webspatial boot shot → `/tmp/pico-render/webspatial/boot.png` |
| `src/editorv32.ts` | 105, 112 | editor baseline JSON → `/tmp/pico-render/<name>.editor-baseline.json` |

Two more for completeness, which are *not* the same defect:

- `src/observation.ts:862` already uses a per-call unique name
  (`os.tmpdir()/pico-render/capture_settled-<uuid>.png`) — unique, but under `os.tmpdir()` rather
  than the retained observation store.
- `test/doors.mjs:370–391` uses the literal `/tmp/pico-render/canonical.png` only as a *fixture
  string* inside fake inner-server responses, proving content passthrough. It is not a path any
  code resolves, and it was left alone.

Side effect worth noting: `scripts/verify-tarball.mjs`'s `[M11]` installed-doors canary runs under
a fixture `HOME`, so after this change it no longer leaves an empty `/tmp/pico-render/` on the
host. `docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md` records that leftover as expected
behaviour under the earlier ruling; that row is now stale, but the file is preserved verbatim by
constraint, so I did not edit it.

---

## Self-review findings

**Completeness** — fallback removed and fail-closed (the module has no replacing primitive left,
not even injectable); both LOOK captures get run-unique retained paths; the `emulator-5554` default
target is unchanged and pinned by a test that reads the fixture adb argv; the three descriptions
say what is actually true per tool; the source scan covers `src/eye.ts`, `dist/eye.js`,
`src/emulatorlook.ts` and `dist/emulatorlook.js`.

**Deviations from the brief's literal text, and why**

1. The brief's test snippets used placeholder helpers `stage(t)` / `publishTarball(...)`; I used the
   file's real helpers (`tempDir`, `seedPriorArchives`, `seedSource`, `publishVerifiedTarball`), as
   the dispatch directed. All four binding assertions are present verbatim in spirit and text.
2. The brief's `"the staged copy is removed"` assertion filters the directory for names containing
   `.publish-`. The staged temporary is actually named `.<basename>.<hex>.part`, so that filter is
   vacuously empty and would pass even if a temporary were left behind. I kept the brief's
   assertion (it is binding) **and** added `assert.deepEqual(fs.readdirSync(archiveDir).sort(), priorNames)`,
   which is the assertion that actually proves nothing was left behind.
3. The brief said to extend "the source-scan list at `:532`". That loop also asserts the scanned
   file must **not** contain `emulator-5554` — which is correct for `verifyapk.ts` and wrong for
   these two tools, whose documented default target is exactly that serial. Adding them to that
   list would have forced a false change. I added an adjacent, dedicated scan instead that asserts
   the `/tmp/pico-render` literal is absent, that `observationCapturePath` is used, and that
   `emulator-5554` is still *present*.
4. I added two tests the brief did not ask for: a per-errno refusal test (all six
   `LINK_UNSUPPORTED` codes, not just the one `EXDEV` a single test would pin) and a direct
   `observationCapturePath` unit test. Both are cheap and pin behavior the brief describes.

**Discipline (YAGNI)** — no other capture tool was touched; the twelve out-of-scope defaults above
are reported, not changed. `src/eye.ts` and `src/emulatorlook.ts` changes are confined to the path
expression, one import, and the descriptions. `mkdirSync` placement was deliberately NOT moved even
though a failed screencap now creates an empty run directory under the observation store — that is
exactly what `capture_frame` already does, and the dispatch says only the default output path
changes.

**Quality** — one responsibility per file; `src/capturepaths.ts` is 30 lines including the header
that records the defect. No large-file concerns introduced.

**Testing** — real behavior, not mocks of the thing under test: the publish tests use real files,
real hard links and real collisions; the capture tests drive the registered handler and read the
file that actually landed on disk. Output is pristine on every green run.

---

## Concerns

1. **I overwrote `/tmp/pico-render/canonical.png` during the RED phase, and I am disclosing it.**
   My Step-4 test called `capture_canonical` with no `outPath` while the implementation still
   pointed at the fixed path, so the handler wrote the test's PNG fixture
   (`test/fixtures/media/valid-small.png`, sha256 `457aadfa…`, 12420 bytes) over whatever that host
   scratch file previously held, at 03:25 local. Its prior content is not recoverable. This is the
   defect itself, reproduced live: a default LOOK capture destroyed an earlier frame under the same
   name. It is host scratch, not anything under `evidence/`, and no repo file cites it by digest
   other than `docs/claims/*` entries already marked `provenance-broken` before this session. After
   the fix the same test writes only under a temp `HOME`, and I confirmed `/tmp/pico-render/` has
   not been written to since (mtime still 03:25 after every later gate run).
2. **This is a behavior change for existing callers.** Any workflow, doc or script that expects the
   frame at `/tmp/pico-render/canonical.png` or `/tmp/pico-render/emulator_look.png` must now read
   the path from the tool's own result (`capture_canonical` returns `path`; `emulator_look` names
   the file in its note text). I found no in-repo consumer that hardcodes either path, but I cannot
   speak for external agent prompts or the plugin skills.
3. **`emulator_look` has no runtime test and could not get one here.** It needs a real qemu window,
   macOS Accessibility and a real CGEvent drag. Its change is covered structurally (source scan +
   the shared helper's own tests) and by code-path inspection only. Recommended verification, when
   the emulator is available to whoever owns it: call `emulator_look` once and confirm the returned
   note names a path under `~/.pico-mcp/cli/observations/emulator-look/<runId>/`, then call it again
   and confirm both files still exist.
4. **`npm ci --offline` was required.** The worktree had no `node_modules` and `npm run build`
   refused. I installed with `npm ci --offline --no-audit --no-fund`, which resolves purely from the
   local npm cache and makes no registry request (129 packages, 465 ms). Nothing global, no
   `PATH` change, no managed CLI store write.
5. **Version stays 38.0.0** and `npm run sync:meta` was not run (no tool-count change; `test:docsmeta`
   confirms zero drift).

---

## Exact log paths

All under `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-3/` in the
worktree `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-hc-t3-2026-09-16`:

| Log | What it holds |
| --- | --- |
| `step2-red-publish-tarball.log` | Step 2 RED — 2 failing, "Missing expected exception" |
| `step3-green-publish-tarball.log` | Step 3 GREEN — 11/11 |
| `step3-green-test-tarball.log` | Step 3 `test:tarball` GREEN |
| `step4-red-eye.log` | Step 4 RED — 3 failing, shows the old `/tmp/pico-render/canonical.png` |
| `step4-red-observation.log` | Step 4 RED — 2 failing |
| `step5-green-eye.log` | Step 5 GREEN — shows the new run-unique path |
| `step5-green-observation.log` | Step 5 `test:observation` GREEN — 50/50 |
| `step5-node-test-publish-tarball.log`, `step5-test-tarball.log`, `step5-test-doors.log`, `step5-test-eye.log`, `step5-test-lint.log`, `step5-test-docsmeta.log`, `step5-test-distribution-adoption.log` | post-implementation gate runs |
| `aux-test-sdkselection.log`, `aux-test-plugin-bootstrap-freshness.log`, `aux-test-conformance.log`, `aux-test-buildfreshness.log` | insurance gates (new `src/*.ts` file) |
| `final-gate-run.log` | the single consolidated final pass: build + all 8 listed commands, each with its `### EXIT=` line |
