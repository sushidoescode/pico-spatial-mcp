# Fix wave FW1 — report (2026-09-16)

Worktree `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-sdk61-evolution-2026-09-15`, branch
`cli050-sdk61-evolution-2026-09-15`, BASE `0f163f5` → HEAD `1c752d2`. Seven brief items, nine commits (seven for the
items and their evidence, two re-wrapping one AGENTS.md paragraph I had left over-wide), every one ending in `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (verified with `git log -1 --format=%B`
over `0f163f5..HEAD`). No push, no history rewrite, no stash. Nothing already under `evidence/` was modified or
deleted (`git diff --diff-filter=DM --stat 0f163f5..HEAD -- evidence/` is empty). Every test run exported
`PICO_ADB=/fixture/no/such/adb` and `npm run build` preceded every run that imports `dist/` (the final battery
starts with `final-dist-freshness.log`: `{"current":true,"reasons":[]}`).

**Environment contact, complete list.** No emulator, device, host adb server, MCP tool, `pico_doctor`, managed
CLI store, npm registry, global CLI/PATH, `~/.pico-mcp` or `rocketsim-mission-replay` contact. Read-only
filesystem lookups only: during design, `find ~/Library/PICO -maxdepth 5 -name adb` (found nothing) and a
per-`$PATH`-entry existence check for `adb` (none on this shell's PATH), to size the hatch guard; at test time
the guard's own `readdirSync`/`statSync`/`realpathSync` over temp directories the tests create, plus — for the
pre-existing hatch tests that pass an env without `HOME` — the fallback read-only walk of the real
`~/Library/PICO` to depth 3 (it holds no adb). `PICO_HOME=~/Library/PICO/sdk` on this host, also adb-free.

| # | Commit | Subject |
|---|---|---|
| 7 | `3b6679d` | chore: untrack a gitignored SDD working file |
| 1 | `0cb2b71` | fix: long pollers read a 20000-line log window; assert_logcat/wait_for_log take maxLines; pico_loop passes a build-length bound |
| 2 | `9c26b2f` | fix: an unseen marker names the dump failure when every dump failed, instead of blaming eviction |
| 3 | `7ec1fa0` | test: invert the logcat-clear source guard instead of pinning it to adb.ts:382 |
| 5+6 | `9d26429` | docs: pico_look names its retained default target; AGENTS.md says where the workflow-level PICO_ADB is the barrier |
| 4 | `a6712a1` | fix: the fixture-adb hatch refuses a real adb by realpath, not just by name |
| — | `e474048` | docs: fix-wave FW1 evidence (RED/GREEN logs per item, final battery) |
| — | `c68979d` | docs: re-wrap the AGENTS.md hatch paragraph to the file's 100-column width (left 105/101-column lines) |
| — | `1c752d2` | docs: finish re-wrapping the AGENTS.md hatch paragraph (every line at most 100 columns) |

Diffstat excluding evidence: 15 files, +573/−441 (−385 of those are the untracked `task-5-report.md`).
Evidence: `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/fixwave/` — 36 logs, force-added
in `e474048` (32), `c68979d` (step13, 2) and `1c752d2` (step14, 2); each begins `# <purpose> (<UTC time>)` and ends `exit=<code>`.

---

## Item 1 — IMPORTANT 1: bounded windows for long pollers (`0cb2b71`)

**What changed**

- `src/logwindow.ts:26-39` — the two false sentences replaced: the module default (`DEFAULT_LOG_WINDOW_MAX_LINES`,
  4000) suits a short tag-filtered read (assert_scene, probe_planes, live_scene_snapshot); the long pollers and
  their bounds are named — assert_logcat (up to 180 s) and wait_for_log read with 20000 unless their `maxLines`
  input says otherwise, build_and_run's settle-long correlation read uses 20000, pico_loop asks assert_logcat for
  50000 because its marker precedes a multi-minute fleet_build; `-t <n>` never returns more than the buffer holds;
  the eviction rate on a real PICO device is unmeasured. `:45` default unchanged (4000); `:47`
  `LONG_POLL_LOG_WINDOW_MAX_LINES = 20_000`; `:49` `BUILD_LENGTH_LOG_WINDOW_MAX_LINES = 50_000`. `readLogWindow`
  itself is unchanged (`:114-128`).
- `src/adb.ts:454` — `assert_logcat` input `maxLines: z.number().int().min(100).max(200000).optional()` whose
  description says why (logd applies `-t` BEFORE the tag filter; default 20000 vs the 4000 module default);
  `:470` `const bound = maxLines ?? LONG_POLL_LOG_WINDOW_MAX_LINES`; `:500` the read passes `maxLines: bound`;
  `:540` the inconclusive result carries `maxLines: bound` and its hint names the bound.
- `src/agentloop.ts:147` — the same input on `wait_for_log`; `:154` bound; `:174` read; `:202` inconclusive text
  names `-t <bound>`.
- `src/workflow.ts:426` — build_and_run: `readLogWindow(runner, window, { maxLines: LONG_POLL_LOG_WINDOW_MAX_LINES,
  timeoutMs: 60_000 })`, with a comment on why (`:418-420`).
- `src/doors.ts:12` import; `:1107-1110` — every `assert_logcat` pico_loop issues after `fleet_build` carries
  `maxLines: BUILD_LENGTH_LOG_WINDOW_MAX_LINES` (50000), with the reason in a comment.

**Covering tests**

- `test/logwindow.mjs:484` assert_logcat: the `maxLines` schema is an integer with minimum 100 / maximum 200000
  and its description says "before the tag filter"; every dump of a default call is `-t 20000`; explicit
  `maxLines: 500` and `50000` are sent verbatim (`-t 500` / `-t 50000`, closing pico_loop's chain end to end);
  `maxLines: 10` is refused by the schema and runs nothing (accepts either SDK rejection style).
- `test/logwindow.mjs:517` wait_for_log: same shape (`-t 20000` default, `-t 500` explicit, under-100 refused).
- `test/logwindow.mjs:725` pico_loop: every recorded `assert_logcat` call carries `maxLines === 50000`.
- `test/logwindow.mjs:544` the three constants exist with 4000/20000/50000, and `src/workflow.ts` has exactly one
  `readLogWindow(runner, window, {…})` which passes `maxLines: LONG_POLL_LOG_WINDOW_MAX_LINES` (source pin).
- `test/smoke.mjs:193-205` — behavioural proof for build_and_run against the hermetic fixture adb: the recorded
  window dump (`logcat -d -v threadtime -t <n>`, PID-scoped dump excluded) carries `-t 20000`. SKIP-recorded on
  Windows, where smoke does not execute build_and_run.

**TDD evidence** — `step1-red-bounds-logwindow.log`: 22 tests, 18 pass, **4 fail** (`actual: undefined,
expected: 'integer'` ×2 — no `maxLines` input on either tool; `undefined !== 20000` — no constant;
`undefined !== 50000` — pico_loop passes no bound). `step1-red-bounds-smoke.log`: `build_and_run window dump
carries the long-poll bound [FAIL]`, and the recorded argv shows `"logcat","-d","-v","threadtime","-t","4000"`.
`step2-build-bounds.log` build. `step3-green-bounds-logwindow.log`: 22/22. `step3-green-bounds-smoke.log`:
`[ok]`, argv now `"-t","20000"`, `Failures: 0`.

**Deviations / notes.** The brief's numbers are the values; I gave them names in the module rather than inlining
literals, so the doc sentences can cite them and the sites cannot drift apart. build_and_run needs the Gradle
fixture to reach its read, so its argv is proven in `smoke` (not in `test/logwindow.mjs`, which holds the source
pin instead). `assert_logcat`'s inconclusive result gained two additive fields (`maxLines`, and with item 2
`dumps`); the matched-result shape is unchanged. Wire contract: `maxLines` is a new optional input on both tools —
T6's CHANGELOG list should carry it, together with "an evicted marker is inconclusive/unmeasurable, never a pass;
eviction rate on hardware unmeasured".

## Item 2 — MINOR 1: a dead adb is a dump failure, not eviction (`9c26b2f`)

**What changed**

- `src/logwindow.ts:132-146` — `unseenMarkerCause({ successfulDumps, lastReadError })`: when no dump succeeded
  and an error is held it returns `every dump failed: <error>; no dump succeeded, so nothing is known about the
  marker` (no eviction claim); otherwise `evicted by log volume, or never written`, with `; the last dump also
  failed: <error> (<n> dump(s) succeeded without the marker)` appended when a later dump failed. `:20-24` the
  module's semantics paragraph states the rule.
- `src/adb.ts:493-494` counters; `:499-508` the loop counts successful reads and keeps `lastReadError` in the
  catch; `:541-542` the inconclusive result carries `dumps: { succeeded, lastError }` and its hint is built from
  the helper, advising "check the adb connection to <serial>" when nothing was read and the re-open/raise-maxLines
  advice otherwise.
- `src/agentloop.ts:168-169`, `:173-182`, `:201-202` — same, in wait_for_log's `fail(...)` text.
- `src/sense.ts:597-598`, `:603-611`, `:627` — probe_planes.
- `src/copilot.ts:91-92`, `:96-104`, `:133` — the snapshot loop.

**Covering tests** (`test/logwindow.mjs`)

- `:566` pure unit case for the helper (all-failed names the error and contains no "evict"; mixed keeps eviction
  and appends the last failure with the count; clean is the plain eviction text).
- `:578` assert_logcat, `:613` wait_for_log, `:629` probe_planes, `:646` live_scene_snapshot — the fixture adb's
  `dumpFails` scenario makes every dump exit 1: each result is `status: inconclusive`, `serial` FIX,
  `logWindow.markerSeen: false`, its hint/error matches `/every dump failed: .*fixture dump failure/`, does NOT
  match `/evicted/`, and no clear happened (assert_logcat also proves the dump was retried).
- `:596` mixed case: the scenario is flipped to `dumpFails` only after the first successful, marker-less dump is
  on record (deterministic — it waits for the argv record, not a timer); the hint keeps "evicted by log volume,
  or never written" and appends `last dump also failed: … (N dump(s) succeeded without the marker)`.

**TDD evidence** — `step4-red-dumpfailure.log`: 28 tests, 22 pass, **6 fail**; the captured hint for a dead adb
reads `… (-t 20000; evicted by log volume, or never written) …` — the defect verbatim. `step5-build-dumpfailure.log`
build; `step5-green-dumpfailure.log`: 28/28.

**Deviation, disclosed.** The brief's parenthetical was "append … ('…or every dump failed: <message>')". A pure
append would still list eviction as a cause when nothing was ever read, which is the misattribution the item
exists to remove; so the wording is conditional — the all-failed hint names the failure (it does contain
`every dump failed: <message>` literally) and claims nothing about eviction, while the mixed case keeps the
eviction finding with the failure appended. One shared helper rather than four hand-written variants.

## Item 3 — MINOR 3: inverted source guard (`7ec1fa0`)

**What changed** — `test/logwindow.mjs:806-870`. `CLEAR_SPELLINGS` keeps both regexes the old guard used
(`"logcat", "-c"` argv incl. the `-b <buffer>` variant; the shell text `logcat -c`). `findLogcatClearSites` collects
`{file, line, text}` over every `src/*.ts`; `assertOnlyExplicitSerialClear` (`:822`) asserts exactly ONE site, that
it is in `adb.ts`, that its text is `await adb(["-s", target, "logcat", "-c"])`, and that within the 20 lines above
it there is an `if (clear) {` branch containing `const target = serial?.trim() ?? "";`, `if (!target) {` and a
`return fail(` naming the explicit-serial requirement. No line number is pinned; the guard still reports the one
site it found (`adb.ts:382` today).

**Covering tests** — `:845` the guard on the real source; `:850` synthetic negatives over the real file set: a
second clear in each of the three spellings (message names `rogue.ts:2` and `adb.ts:<n>`), the one clear moved to
`elsewhere.ts` (refused by file), the explicit-serial derivation replaced by `resolveSerial` (refused by guard
text), a clear naming a resolved serial `s` instead of `target` (refused by form).

**Evidence** — `step6-guard-inverted.log`: 2/2 on the current source (`grep -n '"logcat", "-c"' src/adb.ts` →
`382` only). This is a test refactor, so there is no RED; the synthetic negatives are the proof the guard bites.

## Item 4 — MINOR 4: the hatch refuses a real adb by realpath (`a6712a1`)

**What changed**

- `scripts/gate-inventory.mjs:63-65` `ADB_BASENAMES` (`adb`, `adb.exe`), `REAL_ADB_SCAN_DEPTH = 3`; `:67-81`
  `realpathOrNull` / `isFile`; `:83-119` `knownRealAdbs(env)` → `Map<realpath, where>` from (i) `adb`/`adb.exe`
  directly in each directory of the CALLER env's `PATH` (Windows `Path` fallback), (ii) up to three levels under
  `$PICO_HOME`, (iii) up to three levels under `~/Library/PICO` with HOME from the caller env (`HOME`, then
  `USERPROFILE`, then `os.homedir()`). Filesystem reads only — `readdirSync`/`statSync`/`realpathSync`; unreadable
  directories and dangling links skipped; symlinked directories not followed. `:136-155` `gateChildEnv`: after the
  existing absolute-executable check, `io.realpath(override)`; an unresolvable realpath is refused as not a usable
  fake (`:149`); a realpath present in `knownRealAdbs(env)` is refused with the same code
  `GATE_FIXTURE_ADB_INVALID` and the message `must not be a real adb — it resolves to <realpath>, the adb found
  in <PATH entry …|$PICO_HOME|~/Library/PICO>` (`:151`). The lookup runs only when an override is set, so an
  ordinary gate launch does no extra I/O. `io` now also carries `realpath` and `knownRealAdbs` for injection.
- `scripts/run-gate.mjs:188` fix text: `unset PICO_GATE_FIXTURE_ADB or point it at an executable fake — never a
  real adb`.
- `AGENTS.md:63-66` the hatch sentence states the refusal ("a real adb included: an override whose realpath is an
  adb found in a directory on the caller's PATH or up to three levels under `$PICO_HOME` or `~/Library/PICO` is
  refused the same way, by filesystem reads alone").

**Covering tests** (`test/gate-inventory.mjs`; every case builds its own PATH/PICO_HOME/HOME in temp directories,
never the host's PATH) — `:518` a fake on no lookup path passes; `:524` the same fake first on the caller's PATH is
refused (`/must not be a real adb/`, names PATH and the override), and `adb.exe` too; `:535` a symlink to a PATH
adb is refused and the message carries the symlink target's realpath; `:546` three levels under `$PICO_HOME`
refused, four levels not searched, `~/Library/PICO/sdk/platform-tools/adb` (three levels) refused; `:565`
native-contract gates get the identical env object back even with a PATH adb in the variable; `:572` run-gate
exits 2, spawns nothing, prints the error and the new fix text; `:633` the pre-existing invalid-override case
asserts the full new fix text.

**TDD evidence** — `step7-red-hatch.log`: 52 tests, 47 pass, **5 fail** (the four refusal cases: the override
passed straight through, so `assert.throws` / `exit 2` failed; plus the old fix text). `step10-green-hatch.log`:
52/52. `step12-hatch-clause-distribution-adoption.log` 43/43 and `step12-hatch-clause-docsmeta.log` 26/26 + 0
failures after the AGENTS.md clause (policy-vocabulary scan clean).

**Choices, disclosed.** The brief gave depth ≤3 for `$PICO_HOME` and no depth for `~/Library/PICO`; an unbounded
walk of an SDK tree is not acceptable on every gate launch, so the same three-level bound applies to both and
`REAL_ADB_SCAN_DEPTH` documents it. Symlinked directories are not followed (depth bound + no cycles); a real adb
reachable only through a symlinked directory would pass this guard — the guard is read-only hardening of a
documented hatch, not a proof. The AGENTS.md clause was not asked for by the brief; it keeps the paragraph true and
both doc gates stay green.

## Item 5 — MINOR 5: `pico_look` names its default target (`9d26429`)

**What changed** — `src/doors.ts:534`: after the first sentence, `Default target emulator-5554 (retained this
checkpoint); this door has no serial input.` The door still forwards `capture_canonical {}` unchanged. No stamped
doc repeats the door text (grep over `*.md` for `DOOR 4` / the sentence: none), and the sentence carries none of
the policy vocabulary `test/distribution-adoption.mjs` scans for.

**Covering test** — `test/doors.mjs:717-724`: the listed `pico_look` description matches the exact sentence and
the door's input schema has zero properties.

**TDD evidence** — `step8-red-picolook.log`: `FAIL pico_look does not disclose its default target: inputs=[]
description="DOOR 4 — Capture … ROUTE: …"`, `Failures: 1`. `step11-build-picolook.log` build;
`step11-green-picolook.log`: `ok pico_look discloses its retained default target (emulator-5554) and that it has
no serial input`, `Failures: 0`.

## Item 6 — MINOR 6: AGENTS.md gates.yml wording (`9d26429`)

**What changed** — `AGENTS.md:66-69`: "`gates.yml` keeps the same value at workflow level; it is the barrier only
for the one raw `node --test` step (run-gate replaces it for every gate child). A direct
`node --test test/<file>.mjs` gets neither, so export it yourself." Wrapping: the paragraph is wrapped at 100
columns; `a6712a1` (item 4) joined its clause onto an existing line, leaving a 127-column line, and my first
re-wrap `c68979d` still left 105- and 101-column lines because I committed before reading the width check.
`1c752d2` finishes it with an awk assertion that aborts before the commit (lines 63-69 now 94/94/99/99/97/99/75).
Text unchanged across both; the two doc gates were re-run after each (`step13-rewrap-*.log`,
`step14-rewrap2-*.log`: 43/43 and 26/26 + 0 failures both times).

**Evidence** — `step9-agents-distribution-adoption.log` 43/43; `step9-agents-docsmeta.log` 26/26, main gate
`Failures: 0` (`sync-metadata --check: no stale version/tool-count literals`; `all 169 relative markdown links
resolve`; the worktree `WARN homepage/origin check skipped: ENOTDIR … .git/config` is the known expected noise).

## Item 7 — MINOR 2 (partial): untrack the gitignored SDD file (`3b6679d`)

`git rm --cached .superpowers/sdd/2026-09-16-cli050-host-completion/task-5-report.md`, committed alone with the
exact subject `chore: untrack a gitignored SDD working file`. The file is still on disk (`test -f` → yes) and is
no longer known to git (`git ls-files --error-unmatch` → "did not match any file(s) known to git"); the SDD
directory has zero tracked files. No history rewrite. This report, like the rest of the SDD workspace, is
gitignored and intentionally not committed; T6 copies the workspace `.md` files to
`evidence/…/host-completion/sdd-workspace/` per the review's Minor 2.

---

## Verification — final battery on the final tree (code HEAD `a6712a1`; logs in `e474048`)

After the battery, `c68979d` and `1c752d2` changed only AGENTS.md line breaks; the two gates that read AGENTS.md
(`test:distribution-adoption`, `test:docsmeta`) were re-run after each and are green (step13/step14 logs). No
source, script or test file changed after the battery, and `dist/` was not rebuilt.

`export PICO_ADB=/fixture/no/such/adb`; `final-dist-freshness.log` → `{"current":true,"reasons":[]}`.

| Command | Log | Result |
|---|---|---|
| `node --test test/logwindow.mjs` | `final-logwindow.log` | 29 tests, 29 pass, 0 fail |
| `node --test test/gate-inventory.mjs` | `final-gate-inventory.log` | 52/52 |
| `npm run --silent test:observation` | `gate-test-observation.log` | 79/79 (was 69 in the review; +10 new) |
| `npm run --silent test:doors` | `gate-test-doors.log` | 17/17, `Doors test done. Failures: 0` |
| `npm run --silent test:emulator-restart` | `gate-test-emulator-restart.log` | 690 tests: 689 pass, 0 fail, 1 skipped (pre-existing `frontmostQemu … off Darwin # SKIP`) |
| `npm run --silent test:lint` | `gate-test-lint.log` | 63/63, `Lint fixture test done. Failures: 0` |
| `npm run --silent test:docsmeta` | `gate-test-docsmeta.log` | 26/26, `Docs/metadata gate done. Failures: 0` (ENOTDIR warn = worktree noise) |
| `npm run --silent test:distribution-adoption` | `gate-test-distribution-adoption.log` | 43/43 |
| `npm run --silent test:prompts` | `gate-test-prompts.log` | 3/3 |
| `npm run --silent test:picocli` | `gate-test-picocli.log` | 157/157 + 22/22, `pico-cli lane test done. Failures: 0` |
| extra: `npm run --silent smoke` | `gate-extra-smoke.log` | `Smoke test done. Failures: 0` (12 checks incl. the new bound check) |
| extra: `npm run --silent test:smoke-isolation` | `gate-extra-test-smoke-isolation.log` | 3/3 (smoke twice under two homes, check lists equal) |
| extra: `npm run --silent test:copilot` | `gate-extra-test-copilot.log` | `Copilot test done. Failures: 0` |

The battery streams ran four-in-parallel (each stream sequential); no gate was re-run and none flaked.

## Concerns for the re-review / T6

1. **Item 2 wording is conditional, not a pure append** (see the item) — deliberate, disclosed; the all-failed
   text still contains `every dump failed: <message>` literally.
2. **Item 4 scope choices**: depth 3 for `~/Library/PICO` too; symlinked directories not followed; HOME from the
   caller env with `os.homedir()` fallback (so pre-existing tests that pass no HOME read the real, adb-free
   `~/Library/PICO` — read-only). The guard runs only when the override variable is set.
3. **New wire contract for T6's CHANGELOG/checkpoint**: `maxLines` (100..200000, default 20000) on `assert_logcat`
   and `wait_for_log`; `assert_logcat`'s inconclusive result gains `maxLines` and `dumps:{succeeded,lastError}`;
   inconclusive hint/error wording changed at four sites; `pico_loop` passes `maxLines: 50000`; `build_and_run`
   reads with 20000; the hatch refuses a real adb by realpath and its fix text changed; eviction on hardware is
   unmeasured and an evicted marker is inconclusive/unmeasurable, never a pass.
4. `test/logwindow.mjs` grew by ~13 s (the probe_planes 3 s and snapshot 8 s dump-failure waits); it is still
   inside `test:observation`'s budget (79 tests, ~50 s).
5. Commit grouping differs slightly from the item order: items 5 and 6 share the docs commit `9d26429`; the
   AGENTS.md hatch clause rides in the item-4 commit `a6712a1`.
6. Two extra docs commits (`c68979d`, `1c752d2`) exist only to re-wrap the AGENTS.md paragraph to 100 columns
   after my own edits left it over-wide; the text is unchanged and history was not rewritten to fold them.
