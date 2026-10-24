# Final whole-pass review — host-only completion pass, `dfb3f2d..0f163f5` (2026-09-16)

Reviewed read-only in `.worktrees/cli050-sdk61-evolution-2026-09-15` at HEAD `0f163f5`. No working-tree,
index, HEAD or branch mutation; no emulator, device, host adb server, MCP tool, managed store,
`~/.pico-mcp`, `~/Library/PICO` or registry contact. This report file is the only thing written, and it
sits under the gitignored `.superpowers/` tree.

**What I read.** The spec, the plan, the ledger (every `Ruling:` and every `minor (deferred` line), the
task 1/4/5 briefs, reports and reviews, the task 2/3 reviews and the task 3 incident section in the
sibling worktrees, the task 5 re-review, and the complete non-evidence diff
(`git diff dfb3f2d..0f163f5 -- . ':(exclude)evidence/**'`, 48 files, +3,854/−347) in five passes.
Evidence logs were opened only to check specific claims (T1 step9 RED, T2 clockscale-2 RED, T5 fix1 RED).

**What I ran** (one gate or one file at a time, `PICO_ADB=/fixture/no/such/adb` exported; `dist/` verified
current first via `verifyBuild` → `{current:true}`):

| Run | Result on the final tree |
|---|---|
| `npm run --silent test:observation` | 69/69 (includes the new `test/logwindow.mjs`: every replaced site through the recording fixture adb, the clear tripwire never fired, guard pins `adb.ts:382`) |
| `npm run --silent test:doors` | 17/17 + `Failures: 0`; `every door refuses through the seam on a {} fixture (16/16)`; `exactly three inner() sites`; `pico_perf` forwards an explicit device / omits none |
| `node --test test/gate-inventory.mjs` | 46/46 |
| `node --test test/publish-tarball.mjs` | 11/11 |
| `node test/claimspage.mjs` ×2 | `Failures: 0` both runs; fixture manifest byte-for-byte; live comparison skipped by default |

Also verified directly: all 24 commits carry `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`;
`git diff --diff-filter=DM -- evidence/` over the range is empty (nothing under `evidence/` modified or
deleted); `docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md` is byte-untouched; `src/doors.ts` has exactly
three `await inner()` sites (:359 `innerCall`, :410 `doorCall`, :417 `doorCallRaw`); `src/adb.ts:382` is the
one `"logcat", "-c"` in `src/`; `test/fixtures/claims/expected-manifest.json` contains no host path.

---

### Strengths

- **The isolation work is enforced, not remembered.** `gateChildEnv` (`scripts/gate-inventory.mjs:72-89`)
  replaces whatever `PICO_ADB` the shell inherited — real, empty or whitespace — and the one pass-through is a
  validated absolute executable named in `PICO_GATE_FIXTURE_ADB`; an invalid override refuses the gate with
  exit 2 before any child exists (`scripts/run-gate.mjs:183-190`). The blank rule lives in exactly one place
  (`classifyAdbOverride`, `src/adb.ts:60-77`) and the doctor delegates to it instead of carrying a second trim.
- **The door seam keys on the presence of `dependencies`, not of a lane** (`src/doors.ts:387-389`), so `{}`
  is a fixture and every one of the sixteen doors refuses through `doorCall()`/`doorCallRaw()`. The test pins
  both the behaviour (16/16 refusals over a real in-memory MCP client, 10 s bound per call) and the source
  (three `inner()` sites), and asserts the registered tool set equals the driven set so a future door cannot be
  silently skipped (`test/doors.mjs:295-297`).
- **Every implicit clear is gone and every replaced path fails toward "inconclusive", never toward a match
  against the unscoped buffer.** I traced all eight unseen-marker branches (`assertscene.ts:110`, `sense.ts:612`,
  `copilot.ts:121`, `workflow.ts:440,485`, `adb.ts:522`, `agentloop.ts:191`, `doors.ts:1106`,
  `boundaryexperiment.ts:420`). `pico_loop` maps an inconclusive read to `unmeasurable` so it can never drive a
  replan (`src/doors.ts:1106-1109`). The recording fixture adb in `test/logwindow.mjs` records argv, echoes back
  only markers it was asked to write, refuses untargeted commands and trips exit 97 on any clear — real
  behaviour, not a mock of the code under test.
- **Publication has no replacing primitive left to inject.** `PUBLISH_IO` no longer has `rename`
  (`scripts/publish-tarball.mjs:57-66`); `land()` is link-or-refuse (`:160-176`), every `LINK_UNSUPPORTED` errno
  is covered by a test, and the staged temporary is still removed through the existing `finally`.
- **The Node-major gate is placed after the `receipt.current` short-circuit** (`scripts/build-identity.mjs:327-331`),
  so a healthy pre-change checkout never reaches it and no reinstall storm is possible; ENOENT is the only
  "absence", and an unreadable receipt is unknown provenance (the fix round closed the one real hole).
- **TDD evidence is genuine and specific.** `step9-red-doors.log` shows 14/16 doors answering from a real inner
  server (hermetic: stub adb, scratch HOME, CLI disabled) and `12 inner() sites`; `04-…RED-clockscale-2.log`
  shows the `run-busy` race reproduced; `fix1-red-unreadable-receipt.log` shows `true !== false` on
  `verdict.current` — the laundering itself. The T3 RED-phase host-scratch overwrite was disclosed with file,
  digest and mechanism rather than hidden.
- **Disclosed deviations were the right calls**: `requestedDevice` added because the brief's description sentence
  would otherwise have been false; the boundary sidecar renamed because `collectLogWindow` refuses a pre-existing
  path; the `.publish-` filter kept (binding) but supplemented by the assertion that actually catches a leftover.
- Reviews at every task were substantive (named-risk checks, independent grep/trace, evidence-log cross-checks),
  and the controller's fold-ins (blank-`PICO_ADB` doctor row, `nativefleetreceipt` string read, T5 minors 1/2/4)
  were the correct calls under the spec.

---

### Spec alignment

| Spec item | Verdict | Notes |
|---|---|---|
| 1. Fixture isolation | ✅ exact | inherited/blank/whitespace replaced; explicit harness hatch; blank fails closed in `adb.ts`/`preflight.ts`/`nativefleetreceipt.ts`; every door through the seam with a `{}` test; isolation (stub adb, scratch HOME, `PICO_MCP_CLI_POLICY=disabled`, PATH tripwire) established before the RED runs. |
| 2. Deterministic gates | ✅ exact | fixture ledger through the real writer API; tracked-snapshot consistency checks (section 1) untouched; live-ledger comparison opt-in; `ACQUIRE_BUDGET_MS` and every assertion unchanged; every `monotonicMs()` use in `src/runlocks.ts` is a deadline comparison or the 8 ms-capped `Atomics.wait` interval (:1038-1065, :1513-1564), so the scaled child clock leaks into no cross-process comparison. |
| 3. Artifact preservation | ✅ exact | rename fallback removed at the primitive; `PUBLISH_NO_ATOMIC_PUBLICATION`; canonical + emulator_look retained run-unique paths via one helper; default targets unchanged and disclosed in the two descriptions. |
| 4. No implicit log clear | ✅ exact | assert_scene, probe_planes, copilot snapshot, build_and_run, pico_loop, wait_for_log default, assert_logcat clearFirst, boundary prepare; one explicit clear requires an explicit serial and is checked before `resolveSerial`; results carry `serial` + `logWindow`; incident text untouched. |
| 5. Host correctness | ✅ exact | `nodeMajor` + `provenance`; adoption never crosses majors, never launders unknown/unreadable provenance, never reports `npm-ci`; `check_toolchain_updates` per-component selection; `pico_perf` forwards `device`; `requestedDevice` on every outcome; `0.13.3` provenance comments preserved and exempted by the scan. |
| 6. Battery / artifact / checkpoint | — (T6) | Ledger carries no "red by ruling" exception. |

(a) No fixture gate can reach hardware through an inherited, blank or harness value except the documented
`PICO_GATE_FIXTURE_ADB` hatch (by design). (b) No door on a fixture server can spawn the inner server; the
exported `innerCall()` is used only by `src/spatialbench.ts`. (c) Every implicit clear is gone; every unseen
marker is inconclusive. (d) Publication cannot replace an existing artifact. (e) Adoption cannot cross a Node
major or turn unknown/unreadable provenance into a receipt. (f) Both gates are deterministic without weakened
assertions or production limits. (g) Default targets (`capture_canonical`, `emulator_look`, `perf_diagnose`,
`pico_perf`) unchanged and disclosed in their descriptions — `pico_look`'s is disclosed only transitively (see
Minor 5).

**Rulings vs spec.** All consistent: sequencing (incl. the T4-in-parallel amendment); every test run pinned;
version stays 38.0.0 (defensible for an unreleased line — see Recommendation 4); default targets retained
(spec: "Preserving capture history does not require changing the default target"); the two Task 1 fold-ins are
the spec's item-1 defect class; the Task 5 "unparsable/wrong-schema receipt also blocks adoption" ruling is
exactly "must not turn unknown provenance into verified installation identity"; folding T5 minor 4 (paraphrased
evidence transcript) into the fix round was required by this repo's contract, not optional.

---

### Issues

#### Critical (Must Fix)

None.

#### Important (Should Fix)

**1. The bounded-window contract says long pollers raise `maxLines`; no caller does, so the module's own
documentation is false at every site and the long-window tools are the ones most exposed to eviction.**
`src/logwindow.ts:28` ("callers that poll for long pass a larger `maxLines` rather than trusting a partial
tail") and `:34` ("Callers polling for tens of seconds may raise it") describe a contract that none of the seven
call sites honours: `src/adb.ts:495` (assert_logcat, polls up to 180 s), `src/agentloop.ts:169` (wait_for_log,
default 30 s, unfiltered when no tag), `src/workflow.ts:424` (build_and_run, unfiltered global tail across the
whole settle) and the rest all take the 4000-line default. Because logd applies `-t <count>` to the raw selected
buffers *before* the client-side tag filter (correctly documented at `:26-29`), a chatty XR runtime can push the
marker out of the tail while the filtered output is tiny. The old code read the whole buffer (`logcat -d`), so the
new bound also reads strictly *less* than before. The most exposed path is `pico_loop`: it writes its marker
(`src/doors.ts:1049`) *before* `fleet_build` (`:1054`, a multi-minute Gradle build + install + launch + 16 s
settle) and then asserts with a default bound — on a real device this plausibly makes every logcat criterion
`unmeasurable` and the loop exit `unmeasurable-acceptance`. Nothing here over-claims (the verdict is an honest
inconclusive), and it cannot be measured this pass, but a module contract that no caller follows is a defect.
**Fix [before merge], cheap:** pass a larger bound at the three long-window sites (e.g. `maxLines: 20_000` at
`adb.ts:495`, `agentloop.ts:169`, `workflow.ts:424`; `-t N` never returns more than the buffer holds, so a large
N is harmless), and either (a) also expose `maxLines` as an optional input on `assert_logcat`/`wait_for_log` so
`pico_loop` can pass it, or (b) fix the two doc sentences to say the default is fixed. Either way the checkpoint
must state that the eviction rate on a real PICO device is unmeasured and that an evicted marker yields
`inconclusive`/`unmeasurable`, not a false pass. While touching those lines, fold in Minor 1 (same four sites).

#### Minor (Nice to Have)

1. **Four polling sites discard the dump error and then blame eviction for it** — `src/adb.ts:499`,
   `src/agentloop.ts:173`, `src/sense.ts:603`, `src/copilot.ts:96`. When every dump fails (adb server died,
   device unplugged), `markerSeen` stays `false` and the hint says "evicted by log volume, or never written"
   (`adb.ts:529`, `agentloop.ts:192`). Verdict is safe; the stated cause is wrong. Keep `lastReadError` and append
   it to the inconclusive hint ("…or every dump failed: <error>"). One line each; do it in the same wave as
   Important 1. **[before merge]** if that wave happens.
2. **A gitignored SDD working file is tracked.** `cf0da79` force-added
   `.superpowers/sdd/2026-09-16-cli050-host-completion/task-5-report.md` while `.gitignore:46` ignores
   `.superpowers/` and none of this pass's other SDD files (ledger, briefs, task 1/4 reports, all reviews) is
   tracked. The previous pass's pattern is `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/sdd-workspace/`
   (progress, briefs, reports, final review all copied). T6 should copy this pass's SDD workspace (the `.md`
   files; the `review-*.diff` packages are large and derivable) to
   `evidence/…/host-completion/sdd-workspace/` and `git rm --cached` the stray path in a later commit (no history
   rewrite). docsmeta is unaffected — it filters to root `*.md` + `docs/**` (`test/docsmeta.mjs:145`). **[before merge]**
3. **The source guard is pinned by line number** (`test/logwindow.mjs:613` → `["adb.ts:382"]`, then re-asserts
   line 382's text). Any edit above line 382 in `src/adb.ts` fails the gate with a clear message, which is
   tolerable, but inverting it — find every `"logcat", "-c"` line in `src/`, assert exactly one and that it is
   the `["-s", target, "logcat", "-c"]` form guarded by the explicit-serial check — keeps the strictness without
   the brittleness.
4. **`PICO_GATE_FIXTURE_ADB` accepts a real adb.** `scripts/gate-inventory.mjs:76-83` validates "absolute +
   executable file" only; the variable name and the fix text ("point it at an executable fake") are the whole
   guard. Spec-defined design, so not a violation; the guard text is adequate but could say "never a real adb"
   explicitly, and a read-only hardening is cheap: refuse when `fs.realpathSync(override)` equals the realpath
   of an `adb` found on `PATH` or under `$PICO_HOME`/`~/Library/PICO` (no spawn, no hardware). Must be disclosed
   in the checkpoint either way (already a ledger deferred minor).
5. **`pico_look` does not name its default target.** The door description (`src/doors.ts:534`) says "the
   emulator's current display" and forwards `capture_canonical {}` (`:540`); the retained `emulator-5554`
   default is disclosed only in the inner tool's `outPath`/`serial` descriptions. Since the ruling keeps this
   default as a known gap, one sentence on the door ("default target emulator-5554; there is no serial input")
   makes the retention visible where the agent reads it.
6. **AGENTS.md:65 wording** — "`gates.yml` keeps the same value at workflow level only for its one raw
   `node --test` step" reads as if the env were step-scoped; it is workflow-level and merely *matters* only for
   that step (run-gate replaces it for every gate child, as the gates.yml comment says). Suggest: "keeps the same
   value at workflow level; it is the barrier only for the one raw `node --test` step".
7. **Scaled child clock removes the fast-failure mode for a genuinely stuck capacity child.** With
   `CAPACITY_CHILD_CLOCK_SCALE = "0.01"` (`test/runrevision-locks.mjs:492`) a child's 15 s budget is ~1500 s of
   wall time; a deadlock regression would surface as the gate's timeout rather than a `run-busy` result within
   the test. The production limit is untouched and the assertions are unchanged, so this is not a weakening —
   but a harness-side wall deadline on the two capacity spawners (kill + fail after, say, 120 s) would keep a
   regression loud and fast.
8. **`src/preflight.ts:371-388`** is a four-way nested ternary inside a `push(...)` argument (pass / blank /
   declared / none). Correct; fold into an `adbRow()` helper the next time the file is touched.
9. **`src/assertscene.ts:98`** reports `logWindow.markerSeen: false` on a *broadcast* failure where no read
   happened; the open-failure branch two lines earlier uses `null`. `null` would be truer.
10. **`src/nativefleetreceipt.ts:428`** — `deps?.adbPath != null` accepts an injected `""` and would spawn the
    empty command; the blank *environment* case is now handled but an injected blank is not. Today's only
    production caller passes `ADB()`, which never returns blank; note only.
11. Run-id shape (`<ISO without punctuation>-<uuid>`) now exists in `src/capturepaths.ts:28`,
    `src/picocli.ts:1101`, `src/picoclitools.ts:542` — one shared helper next sweep.

---

### Deferred-minor triage

Every `minor (deferred` line in the ledger, in order.

**Task 1**
- `nativefleetreceipt` adapter branch unreachable in production (`fleetbuild.ts:1222/1243` pass `ADB()` eagerly, outside the producer's envelope; no try/catch between :1150-1250) — **leave**; the string-read trap is genuinely removed; **disclose** in the checkpoint that the `adb-resolution` stage is reachable only for callers that omit `adbPath`, and that fleet_build's own throw is the user-visible refusal.
- `test/doors.mjs:247` "Ten"→"Nine" — **done** in T4 (verified in the diff).
- `gateChildEnv` `io` parameter dead — **leave**.
- Duplicated remedy text (`adb.ts:75` + `refuseOverride`; `preflight.ts:378-379`) — **leave**.
- `preflight.ts` four-way ternary — **leave** (Minor 8; fold on next touch).
- `run-gate` third refusal returns 2 instead of throwing — **leave** (brief-mandated, documented asymmetry).
- Override validator lacks the "exists but not +x" case — **leave** (both `isExecutableFile` branches are covered); a one-line test if `test/gate-inventory.mjs` is touched again.
- `PICO_GATE_FIXTURE_ADB` accepts any executable incl. a real adb — **leave code; must be disclosed** in the checkpoint (Minor 4 offers a cheap hardening).
- `CHANGELOG.md:82-83` "unless the caller set one" now false — **must fix (T6, known)**; confirmed still present at `CHANGELOG.md:83`.
- `doors.ts:387` truthiness → `!== undefined` — **done** in T4 (verified).
- `runrevisiontypes.ts` `adb-resolution` in a persisted `…V1` union, type-only — **leave**; mention in CHANGELOG under the receipt schema notes.

**Task 3**
- docsmeta `WARN homepage/origin check skipped: ENOTDIR … .git/config` in every worktree run — **leave** (pre-existing; `.git` is a file in a worktree); T6 should expect it in the battery log and label it as noise, not a failure.
- Run-id shape duplicated ×3 — **leave** (Minor 11).
- `test/eye.mjs` HOME override without try/finally — **leave** (`check()` never throws; the mocked runner cannot reject).
- Old checkpoint's "`/tmp/pico-render` leftover expected" row now stale — **T6 forward pointer** in the new checkpoint (old document stays as record).

**Task 2**
- `normalize()` matches the two instant keys by bare name — **leave** (safe against today's schema; path-scoped next sweep).
- `recorded()` does not guard `.entry` on a rejected writer — **leave** (unreachable with fixed inputs; failure stays loud).
- Commit `c13fea6` body says "twelve logs" (fourteen) — **leave** (no history rewrite).

**Task 4**
- Four polling sites discard the dump error and attribute an unseen marker to eviction — **fix before merge if the Important-1 wave happens** (same four lines; Minor 1); otherwise leave and disclose.
- No site raises `maxLines` above 4000; `workflow.ts:424` unfiltered across the settle; `assert_logcat` polls up to 180 s — **this is Important 1**.
- Boundary prepare now replays the un-cleared backlog into the streaming collector; a truncated 64 MB window is a hard run failure — **leave code; the checkpoint must say so** (failure mode is an aborted experiment, not a bigger file).
- `pico_loop` iteration report carries `{ marker }` without `markerSeen`/`serial` (`doors.ts:1183`) — **leave** (presentation; inner results carry both).
- Two `probe_planes` failure paths stay prose (`sense.ts:592`, `:620`) — **leave**.
- `assertscene.ts:98` `markerSeen:false` on broadcast failure — **leave** (Minor 9; `null` when next touched).
- AGENTS.md "70 of the 97" → 71 of 98 — **must fix (T6, known)**; still at `AGENTS.md:24`.
- `adb.ts:492` `dumpArgs` built when a window makes it dead — **leave**.

**Task 5**
- Cross-major gate never had an isolated RED — **leave** (recorded honestly; not recoverable; `fix1-red-unreadable-receipt.log` is an isolated RED for the same gate's other branch).
- `test/doors.mjs` canned `perf_diagnose` response reuses `requestedDevice: "fixture-serial"` for the no-device call — **leave** (cosmetic; both assertions read only forwarded args).
- `IDENTITY_SCHEMA_VERSION` bump will cost every host one `npm ci` — **leave (ruled deliberate); disclose** in CHANGELOG/checkpoint so it is not rediscovered.

---

### Recommendations

1. **One small fix wave before T6's battery** (all cheap, all host-only): Important 1 (three `maxLines` args and
   the two doc sentences, or the optional tool input), Minor 1 (retain `lastReadError` at four sites), Minor 2
   (SDD workspace → `evidence/…/host-completion/sdd-workspace/`, `git rm --cached` the stray `.superpowers`
   path), Minor 5 (one sentence on `pico_look`), Minor 6 (AGENTS.md:65 wording). Then a scoped re-review of
   that diff only; the battery runs against the resulting source, as the spec's item 6 requires.
2. **What the new checkpoint must carry** (beyond the plan's list): the T3 RED-phase host-scratch incident
   (`/tmp/pico-render/canonical.png` overwritten once; prior bytes unrecoverable; cannot recur post-fix); the
   `PICO_GATE_FIXTURE_ADB` hatch and its guard; the twelve out-of-scope `/tmp/pico-render` defaults still in
   `src/` (`cameradrive.ts`, `capturerig.ts`, `verifyvisual.ts`, `verifybaseline.ts`, `semanticsplat.ts`,
   `splatanalyze.ts`, `webspatialmv.ts`, `editorv32.ts`, `hybridbuild.ts`, `virtualcamera.ts`,
   `fleetbuild.ts:1175`, `observation.ts:818` is already unique); the marker-eviction limit (unmeasured on
   hardware; inconclusive/unmeasurable, never a pass; `pico_loop` writes its marker before the build); the
   boundary-prepare backlog/truncation consequence; the `adb-resolution` stage's reachability; the retained
   default targets (`pico_look`/`capture_canonical`/`emulator_look` → `emulator-5554`; `perf_diagnose` →
   `DEFAULT_PERF_DEVICE`); the worktree docsmeta `ENOTDIR` warning as expected noise; the emulator_look runtime
   path (qemu window + macOS Accessibility) untested.
3. **CHANGELOG 38.0.0 must record the contract changes** (all backward-compatible in the fail-safe direction,
   but visible): `wait_for_log` matched result is JSON (`{matched, elapsedSec, serial, logWindow, lines}`);
   `assert_logcat` gains `sinceMarker`, `serial`, `logWindow`, and `status:"inconclusive"`; `clearFirst` opens a
   window and erases nothing; `logcat clear:true` requires an explicit serial (no sole-device resolution);
   `build_and_run` output gains required `serial` + `logWindow`; `capture_canonical`/`emulator_look` defaults
   are run-unique retained paths; `verifyDependencies()` gains `provenance`; receipts gain `nodeMajor`;
   `--publish` refuses with `PUBLISH_NO_ATOMIC_PUBLICATION` where hard links are unsupported (no rename);
   `perf_diagnose`/`pico_perf` report `requestedDevice`, `pico_perf` accepts `device`;
   `check_toolchain_updates` `installed.selection` is per-component; `NativeFleetFailureStage` gains
   `adb-resolution`; the run-gate sentence at :82-83 is replaced.
4. **Consider bumping to 38.1.0 (or 38.0.1) at T6.** AGENTS.md says a release *is* a version bump and hosts
   key `/plugin update` off the manifest version. Two byte-different 38.0.0 tarballs with different tool
   contracts now exist; the ruling accepts "under-signals within an unreleased line", which is defensible only
   while no tester holds the earlier `.tgz`. If any does, bump.
5. **Battery hygiene** (already planned, worth restating): run from the worktree with no `PICO_ADB` exported
   and a marker-writing tripwire `adb` first on `PATH`; record the tripwire's silence; expect
   `test:observation` at 69 tests and the docsmeta `ENOTDIR` warning.
6. Next sweep (not this pass): path-scoped `normalize()` in `test/claimspage.mjs`; shared run-id helper;
   `adbRow()` in preflight; consider `-T '<time>'`-based windows as a complement to `-t <count>` once a
   device's log rate is measured.

---

### Assessment

**Ready to merge?** With fixes

**Reasoning:** All five implementation items match the spec exactly — I found no path by which a fixture gate
reaches hardware, a door on a fixture spawns the inner server, an observation clears the device log or matches
an unscoped buffer, a publication replaces an artifact, or a cross-major/unknown-provenance install is adopted —
and every gate I re-ran on the final tree is green. The one Important finding is a documented module contract
(`maxLines` for long pollers) that no call site honours, cheap to fix and cheap to disclose; the rest is
bookkeeping (the stray tracked `.superpowers` file) and the known-stale docs already assigned to Task 6.
