# Task 6 report — rebuild, targeted regressions, the final required battery, a fresh artifact and a fresh checkpoint

Worktree `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-sdk61-evolution-2026-09-15`, branch
`cli050-sdk61-evolution-2026-09-15`. BASE `1c752d2` → TIP **`2a6f494`**. Status: **DONE**.

Five commits, each ending `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (verified:
`dfb3f2d..HEAD` = 38 commits, 38 trailer lines). No push, no history rewrite, no `git stash`,
`main` untouched, no `cd` outside this worktree.

| # | SHA | Subject |
|---|---|---|
| 1 | `896b589` | docs: the maxLines bound names its windowed scope; logwindow names the boundary prepare read |
| 2 | `54ce696` | docs: CHANGELOG 38.0.0 carries this pass's wire contract; AGENTS count re-derived; perf row names its device pass-through |
| 3 | `4022939` | docs: task-6 evidence — targeted gates, the 55/55 battery with no export and a tripwire adb, and the third 38.0.0 artifact's receipt |
| 4 | `61b8bde` | docs: checkpoint the host-only completion pass — merge-ready, with the battery, the artifact lineage and the precise remaining limits |
| 5 | `2a6f494` | docs: correct the checkpoint's own commit count (37 at 61b8bde, 38 with this fix) |

**Environment contact, complete list.** No emulator, device, host adb server, MCP tool,
`pico_doctor`, managed CLI store, npm registry, global CLI or `PATH` change, `~/.pico-mcp`,
`~/Library/PICO` write, or `rocketsim-mission-replay` contact. `PICO_CLAIMS_LIVE_LEDGER` was never
set. Nothing under `evidence/` was modified or deleted
(`git diff --diff-filter=DM --name-only dfb3f2d..HEAD -- evidence/` → 0 files);
`docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md` is byte-untouched over the whole pass
(`git diff --name-only dfb3f2d..HEAD -- <that file>` → 0 files).

---

## Step 1 — the two ruling-assigned description edits (`896b589`)

Text only; no constant, schema range, default or code path moved.

- `src/adb.ts` (`assert_logcat`) and `src/agentloop.ts` (`wait_for_log`): the `maxLines` input
  description now opens "Bound on each raw dump (`logcat -t <n>`) of a WINDOWED read — one opened
  by `clearFirst:true` or named by `sinceMarker`" (`wait_for_log`: "the one `clearFirst:true`
  opens"), and states that without a window there is nothing to slice after, so the poll dumps the
  whole buffer and the input is inert. The existing "BEFORE the tag filter" clause is preserved
  (`test/logwindow.mjs:490` asserts `/before the tag filter/i`). One inline comment added beside
  each `const bound = …` saying the same thing.
- `src/logwindow.ts`: the module header's default-bound caller list now reads "assert_scene,
  probe_planes and live_scene_snapshot (tag-filtered), and the boundary experiment's prepare read
  (boundaryexperiment.ts, `-b all` and untagged, but its one dump immediately follows the marker
  write, so the marker sits at the very end of the tail)". `DEFAULT_LOG_WINDOW_MAX_LINES`'s own doc
  comment says the same.

| Command | Exit | Result | Log (under `evidence/…/host-completion/task-6/`) |
|---|---|---|---|
| `npm run build` | 0 | published 192 files for source `bafeb2712c5b` | `step1-build.log` |
| `npm run --silent test:observation` | 0 | 79 tests / 79 pass / 0 fail / 0 skipped | `step1-test-observation.log` |
| `npm run --silent test:emulator-restart` | 0 | 690 tests / 689 pass / 0 fail / **1 skipped** | `step1-test-emulator-restart.log` |

The one skip is pre-existing and correct: `frontmostQemu returns null without command execution off
Darwin # SKIP` (line 226 of the log) skips because this host IS Darwin.

## Step 2 — doc corrections (`54ce696`)

I read `contradictoryManagedPolicyPatterns` (`test/distribution-adoption.mjs:217-235`) first and
its caller list (`:1884-1892` — the scan covers README, GETTING_STARTED, SKILLS, AGENTS, TESTERS and
docs/HOSTS only). The byte-pinned policy block was not touched and none of its vocabulary was used.

**`CHANGELOG.md`, `## 38.0.0 — 2026-09-15`.** The false run-gate clause ("…unless the caller set
one") is replaced by the enforced rule: the fixture value REPLACES an inherited real/blank/
whitespace `PICO_ADB`; `PICO_GATE_FIXTURE_ADB` naming an absolute executable fake is the one
pass-through and anything else refuses the gate (exit 2) before a child exists, a real adb included
(refused by realpath against the caller's PATH, `$PICO_HOME` and `~/Library/PICO`, filesystem reads
only); a blank value fails closed in `src/adb.ts`, in the doctor's adb row and in the native fleet
receipt reader. Nine bullets were then appended — **no existing entry moved or deleted** — covering
the final review's Recommendation 3 list plus the fix-wave additions: the marker-window observation
contract (`sinceMarker`/`serial`/`logWindow`/`status:"inconclusive"` on `assert_logcat`;
`wait_for_log`'s JSON matched result; `build_and_run`'s required `serial` + `logWindow`;
`clearFirst` erasing nothing; `logcat clear:true` requiring an explicit serial); `maxLines`
(100..200000, default 20000), its windowed-read scope, `pico_loop`'s 50000, `build_and_run`'s
20000, the inconclusive result's `maxLines` + `dumps:{succeeded,lastError}`, and the unmeasured
eviction rate; run-unique retained `capture_canonical`/`emulator_look` defaults with the target
unchanged; `PUBLISH_NO_ATOMIC_PUBLICATION` with no rename fallback; receipt `nodeMajor` +
`verifyDependencies().provenance`, the cross-major/unknown/unreadable-provenance reinstall and the
one-`npm ci` cost of a schema bump; per-component `installed.selection`; `requestedDevice` and
`pico_perf.device`; `NativeFleetFailureStage`'s `adb-resolution`; the `test:claims` fixture ledger
with the opt-in `PICO_CLAIMS_LIVE_LEDGER=1`; the `PICO_RUNLOCK_CHILD_CLOCK_SCALE` test knob.
Version stays 38.0.0 (controller ruling); the reviewer's caveat is in the checkpoint, not here.
The link to the new checkpoint was added later, in `61b8bde`, so that no commit ever carried a link
to a file that did not yet exist.

**`AGENTS.md`.** The dist-import sentence re-derived with the exact command it quotes: **71 of the
98** `test/*.mjs` files (was "70 of the 97"). Measured three ways, all agreeing:
`grep -lE '(from|import\()[[:space:]]*"\.\./dist/' test/*.mjs | wc -l` → 71 (this shell's `grep` is
a ugrep shim), `/usr/bin/grep` with the same expression → 71, and an independent python `re` scan →
71 of 98. Nothing else in AGENTS.md.

**`docs/findings/CLI050_CAPABILITY_MATRIX.md`.** The `perf live run` row's intent column now reads
"`perf_diagnose`, and the `pico_perf` door", and the row gains an explicit paragraph: the door
accepts an optional `device` and forwards it, `perf_diagnose` passes it through to `--device`, and
both report `requestedDevice` on every outcome; `DEFAULT_PERF_DEVICE` (= `emulator-5554`,
`src/perfcli.ts:74`) is retained by ruling and stays a disclosed gap. The "2. Performance" section
below gained the same three facts.

| Command | Exit | Result | Log |
|---|---|---|---|
| `node scripts/sync-metadata.mjs --check` | 0 | `0 stale site(s), 0 warning(s)`; truth `version=38.0.0 macOS-tools=255 other-host-tools=252 doors=18` | `step2-sync-metadata-check.log` |
| `npm run --silent test:docsmeta` | 0 | 26/26, `Docs/metadata gate done. Failures: 0` | `step2-test-docsmeta.log` |
| `npm run --silent test:distribution-adoption` | 0 | 43/43 | `step2-test-distribution-adoption.log` |
| `npm run --silent test:lint` | 0 | 63/63, `Lint fixture test done. Failures: 0` | `step2-test-lint.log` |

## Step 3 — rebuild and the eighteen targeted gates on the final source

`npm run build` → exit 0, source `bafeb2712c5b` (`step3-build.log`); `verifyBuild(cwd)` →
`{"current":true,"reasons":[]}` (`step3-dist-freshness.log`). Every gate run as
`npm run --silent <gate>` (each pins its own children), one log each.

| Gate | Exit | Result | Log |
|---|---|---|---|
| `test:lint` | 0 | 63/63, Failures: 0 | `step3-test-lint.log` |
| `test:docsmeta` | 0 | 26/26, Failures: 0 | `step3-test-docsmeta.log` |
| `test:distribution-adoption` | 0 | 43/43 | `step3-test-distribution-adoption.log` |
| `test:doors` | 0 | 17/17, `Doors test done. Failures: 0` | `step3-test-doors.log` |
| `test:sdkselection` | 0 | 177/177 | `step3-test-sdkselection.log` |
| `test:observation` | 0 | 79/79 | `step3-test-observation.log` |
| `test:eye` | 0 | `Eye calibration test done. Failures: 0` + `USD render producer test done. Failures: 0` | `step3-test-eye.log` |
| `test:tarball` | 0 | 11/11, `Tarball verification done. Failures: 0` | `step3-test-tarball.log` |
| `test:claims` | 0 | `Claims-page test done. Failures: 0` | `step3-test-claims.log` |
| `test:runrevision` | 0 | 327/327 | `step3-test-runrevision.log` |
| `test:buildfreshness` | 0 | 26/26 | `step3-test-buildfreshness.log` |
| `test:plugin-bootstrap-freshness` | 0 | 31/31 | `step3-test-plugin-bootstrap-freshness.log` |
| `test:picocli` | 0 | 157/157 + 22/22, Failures: 0 | `step3-test-picocli.log` |
| `test:conformance` | 0 | 69/69, `Sample-conformance gate done. Failures: 0` | `step3-test-conformance.log` |
| `test:emulator-restart` | 0 | 690 / 689 pass / 0 fail / 1 pre-existing skip | `step3-test-emulator-restart.log` |
| `test:preflight` | 0 | `Preflight test done. Failures: 0` | `step3-test-preflight.log` |
| `test:prompts` | 0 | 3/3 | `step3-test-prompts.log` |
| `smoke` | 0 | `Smoke test done. Failures: 0` | `step3-smoke.log` |

All eighteen green. Nothing was weakened, skipped or retried.

## Step 4 — the final required battery

**Method.** `unset PICO_ADB` (it was not set ambiently either; only `PICO_HOME` was), then a
marker-writing tripwire `adb` first on `PATH` — a `/bin/sh` script that appends
`<utc> pid= ppid= cwd= argv=…` to
`evidence/…/host-completion/task-6/step4-tripwire-adb-marker.txt` and exits 66. **Self-tested
first**: `adb devices` resolved to the tripwire, exited 66 and recorded
`2026-09-16T13:17:59Z … argv=devices`; the self-test marker was then deleted and confirmed absent.
The script is retained as `step4-tripwire-adb.sh`; the preconditions (`PICO_ADB` `<unset>`,
`command -v adb` → the tripwire, `PATH[0]`, HEAD) are in `step4-battery-preconditions.log`.

```
node scripts/run-battery.mjs "$PWD" \
  "$PWD/evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/host-completion/battery-38.0.0-host-completion.log"
```

**Summary line, verbatim:**

```
BATTERY PASS 55/55 (0 failed)
```

Wrapper exit `BATTERY_EXIT=0`. The runner appends a skip summary when a `native-contract` gate
belongs to another OS; it named none, so **no gate was skipped** — `batteryPlan()` on this macOS
host is `run: 55, skipped: []`, and the log shows `test:vcamtransport-native` and
`test:vcamreader-native` really compiling and running their contracts (exit 0 each) rather than
taking the off-Darwin no-op path. Two skips inside otherwise-passing gates, both named in the
checkpoint: `test:emulator-restart`'s pre-existing off-Darwin `frontmostQemu` case, and
`test:vcamreader-native`'s "reader is authorized; skipping the readback-block assertion to stay
device-free".

**Tripwire result: the marker file DOES NOT EXIST.** Nothing in the 55-gate battery resolved `adb`
from `PATH`. Re-checked again after the publish step: still absent.

- Aggregate log: `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/host-completion/battery-38.0.0-host-completion.log` (450,747 bytes)
- Runner stdout (stderr merged): `…/release/host-completion/battery-38.0.0-host-completion.runner.out`
- The `WARN homepage/origin check skipped: ENOTDIR … .git/config` inside `test:docsmeta` appears
  once and is the known worktree noise (`.git` is a file in a worktree), not a failure.

No gate was red, so no investigation, retry or weakening was needed.

## Step 5 — the fresh artifact (`node scripts/verify-tarball.mjs --publish …`)

Exit 0, `Tarball verification done. Failures: 0` (`step5-verify-tarball-publish.log`).

**New receipt identities** (`evidence/…/release/host-completion/pico-spatial-mcp-38.0.0.tgz.receipt.json`, tracked):

| Field | Value |
|---|---|
| `artifact.sha256` | `ff394fbbcdf1828ea0745e3d7ad4fe931a2a46e7b910ea309f67c82c6858d042` |
| `artifact.bytes` | `2176424` (2,176,424) |
| `build.input` | sha256 `bafeb2712c5b635d18a2a6a4523b41dc7a7eeee6e940bbe95c214822cd0628db`, 197 files |
| `build.output` | sha256 `f4978b711f570efda70ef91f4a8c8157cadc231daab7ccc103909a36ee61c24d`, 192 files |
| `build.typescript` / `build.nodeMajor` | `5.9.3` / `25` |
| `platform` | `darwin` / `arm64` / `v25.8.1` |
| `package` | `pico-spatial-mcp` `38.0.0` |
| `checks` | **48, all `pass`** (0 fail, 0 skip) — includes "installed server listed exactly 255 tools for darwin", "doors surface registered all 18 door tools", "packed dist/build-receipt.json binds the payload to source bafeb2712c5b / output f4978b711f57" |

`shasum -a 256` on the published file independently returns the same digest. Only the receipt was
`git add`ed; the `.tgz` stays untracked (gitignored by `.gitignore:33 *.tgz`).

**The two earlier tarballs are byte-unchanged** — re-verified before and after the publish
(`step5-earlier-tarballs-unchanged.log`, `step5-artifact-lineage.log`):

```
941e402bb2c234c444e31c62c9bc9dc2c69055ac3aeee48c960e870e100f36d6  ./pico-spatial-mcp-38.0.0.tgz            (2158783 bytes)
c08e1a8baf2b850cae5bdd09eb259fab5270645dda3d635eeb1bc7cb51c435f5  ./final/pico-spatial-mcp-38.0.0.tgz      (2161859 bytes)
ff394fbbcdf1828ea0745e3d7ad4fe931a2a46e7b910ea309f67c82c6858d042  ./host-completion/pico-spatial-mcp-38.0.0.tgz (2176424 bytes)
```

Both match the expected values in the brief exactly.

## Step 6 — the checkpoint (`61b8bde`, corrected in `2a6f494`)

New file `docs/findings/CLI050_HOST_COMPLETION_CHECKPOINT.md` (384 lines). It carries, with every
claim labeled `fixture` / `source-derived` / `host-executed` and nothing native, visual, device,
cross-platform or end-to-end:

- **Identity** — branch, base `dfb3f2d`, tip, 38 commits, build receipt in/out digests, toolchain,
  and the **version ruling with the reviewer's caveat recorded unwaived**: 38.0.0 stands because no
  tarball of this line has been distributed, but if any tester holds an earlier 38.0.0 `.tgz` the
  version must be bumped before release, since `/plugin update` keys off the manifest version and
  three byte-different 38.0.0 tarballs now exist.
- **Per task 1–5 and fix wave FW1** — what changed, commits, tests with counts, the review verdict
  and fix rounds (T5's one round is stated as such), and the evidence directory, linked.
- **Incidents of this pass** — Task 3's RED run overwrote `/tmp/pico-render/canonical.png` once
  (the defect reproduced live; prior bytes unrecoverable; cannot recur post-fix); the plain
  statement that no emulator, device or host adb server was contacted in any phase; and a reference
  to the 2026-09-15 checkpoint's three incidents **by section, not rewritten**, with the statement
  that the clearing mechanism behind Incident 3 no longer exists and that the pin and the hatch are
  now enforced rather than remembered.
- **The battery** — method, the verbatim summary, both log paths, the tripwire's absence, the
  docsmeta ENOTDIR line labeled as worktree noise, and a test-count-change table against the
  2026-09-15 final battery (`test:observation` 48 → 79, `test:lint` 49 → 63, `test:sdkselection`
  175 → 177, `test:plugin-bootstrap-freshness` 27 → 31, `test:claims` red → green,
  `test:runrevision` 327 fragile → 327 deterministic, the rest unchanged).
- **Artifact lineage** — the three-row table with each artifact's sha256, byte size, build
  input/output identities and check counts; the earlier two marked byte-identical and superseded;
  where the receipts are tracked.
- **Forward pointers** — nine now-stale rows of the 2026-09-15 checkpoint, including "caller-set
  value wins", the `/tmp/pico-render` leftover row, `test:claims` "red by ruling", the
  `test:runrevision` timing row and the CHANGELOG sentence.
- **Remaining acceptance limits**, precisely as the brief enumerates them, including: profiler
  payload provisioning (user-run setup) and the absent exit-0 perf help; host-plugin discovery;
  real Linux/Windows `tools/list` (252 is source-derived); emulator LOOK acceptance (calibration
  stale since the 2026-09-15 boot; root alone owns `emulator-5554`); a physical device only on the
  user's authorization; `emulator_look`'s untested runtime path (qemu window + macOS
  Accessibility); the retained default targets by ruling; marker eviction unmeasured on hardware
  and never a pass, `pico_loop` writing its marker before the build, `probe_planes`' possible 60 s
  poll on the default bound, and `maxLines` being inert on an unwindowed read; the boundary
  prepare's backlog replay and its 64 MB truncation as a hard run failure; the twelve remaining
  fixed `/tmp/pico-render` defaults, listed file:line from task-3-report.md; the
  `PICO_GATE_FIXTURE_ADB` hatch, its realpath guard and the two pre-existing tests that read the
  adb-free `~/Library/PICO` read-only; the `adb-resolution` stage's reachability only for callers
  omitting `adbPath`; the corrupt/old-shape receipt's one-`npm ci` cost; and the inverted guard's
  20-line proximity pin.

Relative links are used only for paths that exist; untracked paths are in backticks (docsmeta
strips code spans before scanning). Gates after writing it:

| Command | Exit | Result | Log |
|---|---|---|---|
| `npm run --silent test:docsmeta` | 0 | 26/26; `all 189 relative markdown links resolve (77 git-tracked files)` | `step6-test-docsmeta.log`, re-run `step7-test-docsmeta.log` |
| `npm run --silent test:distribution-adoption` | 0 | 43/43 | `step6-…`, `step7-…` |
| `npm run --silent test:lint` | 0 | 63/63 | `step6-…`, `step7-…` |

**One self-correction, disclosed.** `61b8bde` stated 39 commits in `dfb3f2d..HEAD`; the real count
at that commit was 37. Rather than amend (no history rewrite), `2a6f494` corrects the row to 38 —
the count *including* that correction — and rewrites the Tip row to say exactly which commit
carries what, so the number is checkable against the branch. `git rev-list --count dfb3f2d..HEAD`
= 38 at the tip. The step7 logs are the gate re-runs after that edit.

## Step 7 — force-added evidence and final state

`4022939` force-added 32 logs plus `step4-tripwire-adb.sh`, the battery log, the runner stdout and
the publication receipt; `61b8bde` and `2a6f494` force-added the step6/step7 gate logs. The task-6
directory holds 38 files.

```
$ git status --short --untracked-files=all
(empty)
$ git status --short --ignored=matching --untracked-files=all | grep pico-spatial-mcp-38.0.0.tgz
!! evidence/…/release/host-completion/pico-spatial-mcp-38.0.0.tgz     (plus the two earlier ones)
```

Clean except the untracked `.tgz` files, exactly as required. `verifyBuild(cwd)` at the tip:
`{"current":true,"reasons":[]}`.

## Files changed

| File | Change |
|---|---|
| `src/adb.ts` | `maxLines` description names its windowed scope; one inline comment |
| `src/agentloop.ts` | same, for `wait_for_log` |
| `src/logwindow.ts` | default-bound caller list and the constant's doc comment name the boundary prepare read |
| `CHANGELOG.md` | 38.0.0: run-gate sentence replaced; nine bullets appended; link to the new checkpoint |
| `AGENTS.md` | "71 of the 98 `test/*.mjs` files" |
| `docs/findings/CLI050_CAPABILITY_MATRIX.md` | perf row + performance section: `device` pass-through, `requestedDevice`, retained default |
| `docs/findings/CLI050_HOST_COMPLETION_CHECKPOINT.md` | **new** |
| `evidence/…/host-completion/task-6/` | 38 files (37 logs + the tripwire script) |
| `evidence/…/release/host-completion/` | battery log, runner stdout, receipt (tracked); `.tgz` untracked |

## Not done, and why

- **The SDD-workspace copy into `evidence/…/host-completion/sdd-workspace/`** (final review Minor 2,
  second half) was **not** done: the ledger's FW1 ruling assigns it to the controller's final
  evidence commit after this task's review, not to Task 6.
- **No version bump.** Controller ruling; the reviewer's caveat is recorded in the checkpoint as a
  release-time gate rather than acted on here.
- **Nothing native, visual, device, cross-platform or end-to-end was attempted or claimed.** No
  frame was produced, so no frame was looked at; the strongest class earned is `host-executed`.
- Minors 7–11 of the final review and its Recommendation 6 items remain deferred to the next sweep,
  as ruled; the three surviving Low residuals from the FW1 re-review that were not description
  truths are disclosed in the checkpoint rather than fixed.
