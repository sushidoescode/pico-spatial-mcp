# Task C3 report — Correct watcher timing and retain observation coverage

Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-cli-2026-09-15` (branch `track/cli050-cli`, base `f743b0b` = C1+C2 complete).
Commit (never pushed): `81970cc` — *fix: report observed crash-watch coverage and pass the native monitor timeout* (7 files, +1180/−82), trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. `git diff --name-only f743b0b HEAD` lists exactly the seven owned files and nothing else.

Status: **DONE**, with one documented deviation from controller resolution 3 (the watchdog grace; measured justification and the alternative are in "Deviation" below — the controller should confirm or overrule it).

No emulator, no device, no MCP tool, no real `pico-cli`, no install and no `setup`: every child in every test is a fake node script driven by the production bounded runner, and every long duration comes from an injected monotonic clock.

## What was implemented

### 1. `src/cliobservations.ts` (new, 200 lines) — pure coverage/argv arithmetic

No fs, no spawn, no clock of its own. Exports:

- **`ObservationCoverage`** — verbatim from the brief, plus `ObservationCoverageKeys` so a consumer can pin the exact field set (a test asserts the rendered object has those six keys and nothing else).
- **`watchArgv(packageName, serial, durationSec, nativeTimeout)`** — verbatim from the brief. `--monitor-timeout` is appended only when the caller proved the flag exists.
- **`assessCoverage({requestedDurationSec, elapsedSec, nativeTimeoutSupported, endedBy, exitCode, outputComplete, monitoredSec})`** — the signature from resolution 1. Grading ladder:
  - `endedBy: "error"` → `unknown` (nothing was observed).
  - **No native timeout**: `unknown` when the CLI exited before the requested wall-clock window (the window was never handed to it, so an early exit establishes nothing); `partial` once the requested wall clock elapsed (our observation is bounded, the CLI's monitoring is not). Never `complete`.
  - **Native timeout**: `partial` when output was truncated, when the exit code is nonzero, or when the CLI returned before its own deadline (`cli-exit`); `complete` only when `elapsedSec >= requestedDurationSec`, the end was `native-duration` or `watchdog`, the exit was clean and the output whole.
  - `monitoredSec` passes through and is `null` from every production call — see below.
- **`classifyWatchEnd`** — separates the CLI's own duration from our watchdog. `native-duration` is claimed only when we passed `--monitor-timeout` **and** the child survived at least the whole requested window; the CLI's deadline starts inside the child, after ours, so a genuine native expiry always reads `elapsed >= requested`. Anything shorter is `cli-exit` (the CLI returning for its own reason).
- **`watchAssessment`** — `crash-indicated` when markers were found; `no-crash-detected` **only** when coverage is `complete` *and* the scan was complete; `inconclusive` otherwise. This is the "never translate a quiet partial window into no-crash success" rule.
- **`describeCoverage`** — one sentence naming what the grade does and does not establish, returned as `coverageNote`.
- **`MONITORED_WINDOW_UNAVAILABLE`**, **`WATCH_WATCHDOG_GRACE_SEC = 20`**, **`watchWatchdogBoundSec`**.

**`monitoredSec` is always `null`, and the constant says why** (pinned by a test): 0.4.4 prints only "No crash detected during the monitoring window", and 0.5.0 prints "No crash detected during the `<requested>`s monitoring window" — the *requested* budget echoed back. Neither line reports the time actually spent monitoring after device resolution, the optional launch and the PID wait were paid out of the same deadline. Elapsed wall-clock time is therefore not monitoring time, and the module's header documents that with the excerpt ids.

Retained CLI facts cited in the code comments:
- **WATCH044** + help fixture `0.4.4/025`: no duration flag (only `--launch-timeout <seconds>`, default 30), then an **internal 30-second monitoring loop** (`for(;Date.now()-o<3e4;)`). The old wrapper claim that the CLI "streams indefinitely" was wrong in both directions and is gone.
- **WATCH_ARGS050 / WATCH050** + help fixture `0.5.0/096`: `--monitor-timeout <seconds>`, default 30, "Total wall-clock seconds to wait for the process and crash signals"; one absolute deadline `a = start + timeout` shared by device resolution, the `--start` launch, the PID wait, every poll sleep and the final log collection; early returns with no PID, and on any process change where confirmed correlated crash evidence is distinguished from a restart/exit with no correlated evidence.

### 2. `src/clicapabilities.ts` — watch route facts + the moved failure-class map

- `CliOperationRoute` gains **`nativeDurationFlag: CliRouteDurationFlag | null`** (`{flag, provenance}`). Only 0.5.x `watch-crash` carries one, citing `index.json 0.5.0/096`'s advertised option text plus WATCH_ARGS050/WATCH050; 0.4.x `watch-crash` carries an explicit comment that `0.4.4/025` advertises `--launch-timeout` only. No other operation on either line has a flag (pinned by a test over all `CLI_OPERATIONS`).
- **`cliOperationNativeDurationFlag(version, operation)`** is the accessor. It refuses to answer for an unparseable version: `cliOperationRoutes` deliberately probes an unrecognizable line with the newest table (candidate argv the *evidence* then judges), but a duration flag is a positive claim that nothing would judge, so `""`/`"unknown"`/`"nightly"` → `null` (tested).
- **`capabilityFailureClass`** moved here from `src/knowledge.ts:928-933` (the C2 review request), beside `capabilityNeedsFreshDiscovery`, with a new `CapabilityFailureClass` union (a subset of `PicoCliFailureClass`, so knowledge.ts's typing is unchanged). `src/knowledge.ts` changed by exactly one import line plus the removal of the moved function — the diff is 10 lines and contains nothing else.

### 3. `src/picocli.ts` — operation-conditional environment remedy + immutable observation retention

- **`describePicoCliEnvironmentFailure(stderr, stdout, operation?)`**: the "before locating its profiler payload" clause is now conditional. PERF_ENV050 places the PICO_HOME read inside the *profiler-entry resolver*, so only `perf-live` / `trace-*` may claim it; any other operation gets the same PICO_HOME remedy without attributing a cause we have not observed for it. The two-argument form is unchanged (the existing assertion in `test/picocli.mjs` still passes), and no branch prescribes running setup.
- **`retainPicoCliObservation(input, root = picoCliObservationRoot())`** + **`picoCliObservationRoot()`**: bounded raw stdout/stderr written once into `<managedRoot>/observations/<operation>/<runId>/` — deliberately beside the per-operation help evidence discovery already retains at `<managedRoot>/capabilities/<version>/<identityKey>/<runId>/` (picoclimanaged.ts), and following the same rules: the run directory is created **non-recursively** and every file is opened **`wx`** and fsynced, so an existing run is refused rather than overwritten. Writes `stdout.txt`, `stderr.txt` and an `observation.json` record (argv, exit code, signal, timedOut, outputTruncated, spawnError, per-stream sha256 + byte counts, and caller metadata). A retention failure returns `{retained:false, error}` and never throws — the observation is still reported, without evidence paths.

### 4. `src/picoclitools.ts` — `watch_crash` rewritten around an injectable seam

`observeWatchCrash(request, runtime)` is exported with a `WatchCrashRuntime` seam (`now`, `capability`, `nativeDurationFlag`, `run`, `retain`, `cliPath`, `cliRaw`). The tool handler builds the production runtime; `now` is `performance.now()` (monotonic, so a wall-clock adjustment mid-watch cannot inflate or shrink the observed window). Flow:

1. **Capability gate.** `picoCliOperationCapability(cli, "watch-crash")` must be `supported` with a non-empty route, or the wrapper returns `status:"failed"` **without spawning anything**, carrying `capabilityFailureClass` and a `capability` disclosure (`state`, verbatim `reason`, `argvPrefix`, evidence paths). `setup-required` returns the byte-pinned neutral note and `setupCommand`; `environment` returns the operation-scoped PICO_HOME remedy; `flag-or-version-drift` and `cli-unusable` get their own guidance. No `watchedSec` and no `observation` on this path — nothing was observed.
2. **Native timeout selection.** `nativeTimeoutSupported` is true only when the capability is `supported` **and** `cliOperationNativeDurationFlag(cli.version, "watch-crash")` returns the `--monitor-timeout` fact. Never a version-string comparison alone.
3. **Outer watchdog**, then the bounded run through the existing `runPicoCli` spawn boundary (no second spawner).
4. **Immutable retention** of the bounded raw streams, with the coverage, watchdog bound, duration flag and capability reason as metadata.
5. **Coverage + honest reporting.**

Result changes: `watchedSec` is now the **observed** elapsed seconds; new `requestedDurationSec`, `nativeTimeoutSupported`, `observation` (the `ObservationCoverage` object), `coverageNote`, `retainedLog` / `retainedLogError`, `capability`, `assessment`. The crash-marker scan reads the **complete** captured/retained log, not the 40-line UI tail (`crashScanComplete` is false when the retained log itself was truncated). The top-level `endedBy` prose keeps its `duration-cap …` / `cli-exit …` prefixes for compatibility and no longer says "pico-cli has no duration flag". The tool description and typed `outputSchema` were updated to state all of this, including an explicit `MEANING CHANGED (C3)` note on `watchedSec`.

`capture_record` was left alone (C6 owns its media validation, and its argv/capability gating did not need to change for consistency here) — see Concerns.

## watchedSec meaning change — for the release notes

> **`watch_crash.watchedSec` changed meaning.** It used to be the *requested* window (`durationSec`), returned unchanged whether the CLI ran for the full window or exited after one second. It is now the **observed** elapsed window, measured with a monotonic clock, and it can be far shorter than the request. The requested value moved to the new `requestedDurationSec` field, and the new `observation` object (`coverage`: `complete` | `partial` | `unknown`) says how much of the request was actually covered. A quiet window now reports `assessment:"inconclusive"` rather than reading as a no-crash result unless coverage is `complete` and the log scan was complete. Consumers that treated `watchedSec` as "the window I asked for" must read `requestedDurationSec` instead.

Two related surface changes in the same tool: `watch_crash` now refuses to dispatch without verified `app watch-crash` capability evidence for the resolved package (returning `status:"failed"` with a `capability` disclosure instead of spawning), and on a CLI line that advertises `--monitor-timeout` the requested window is handed to the CLI itself instead of being enforced only by an outer kill.

## Deviation from controller resolution 3 — the watchdog grace (needs a decision)

Resolution 3 specified a hard settlement bound of `requestedDurationSec + GRACE` for every run. Implemented as written, it **breaks a test file outside my ownership**: `test/picocli-autoinstall.mjs`'s parent test "Task 4 production adapters use the managed absolute CLI without eager provisioning" has `timeout: 45_000` and contains two `operationMode:"hang"` `watch_crash` subtests at `durationSec: 5`. Those went from ~6 s each to ~26 s each. Measured result of that build:

```
✖ Task 4 production adapters use the managed absolute CLI without eager provisioning (45000.167333ms)
  'test timed out after 45000ms'
✖ watch_crash rejects a post-completion managed guard failure (13491.547125ms)
  'test did not finish before its parent and was cancelled'
  (+ 4 later subtests "could not be started because its parent finished")
ℹ tests 157  pass 151  fail 4  cancelled 2
```

I cannot edit that file, and the headroom is ~11 s in total, so no value of GRACE ≥ ~5 s fits with any margin.

**What I shipped instead:** `watchWatchdogBoundSec(requestedDurationSec, nativeTimeoutSupported)` adds the grace **only when the requested window was actually handed to the CLI** through its own duration flag; otherwise the bound is the requested window, exactly as before this task. The substantive argument, not just the test:

- The grace's purpose is to let the CLI settle *inside a deadline we gave it*. On 0.5.x, killing at exactly the requested second could cut off the launch, PID wait or final log collection that WATCH050 charges to that same deadline — destroying evidence it was about to print.
- On a line with **no** duration flag the CLI was never given this window. Its own bound is a constant we did not set (WATCH044: up to `--launch-timeout` = 30 s of PID waiting, then an internal 30 s loop), which 20 s of grace could not cover anyway. Waiting past the request buys latency, not evidence: coverage is capped at `partial` either way, and the grace would make the reported **observed** window longer than the window the caller asked for — the opposite of this task's goal.

Both bounds are pinned by tests (`watchWatchdogBoundSec(60,true) === 80`, `(60,false) === 60`, plus an end-to-end assertion that the production `timeoutMs` handed to the runner is 80 000 ms for a native 60 s request and 60 000 ms without the flag). If the controller prefers the literal resolution, the change is one line in `src/cliobservations.ts` plus a test update, and the release track must then relax `test/picocli-autoinstall.mjs`'s 45 s parent timeout.

## TDD evidence

**RED** (both test files written before any implementation, run against the C2 build; saved under the session scratchpad `red/`):

```
$ node --test test/cliobservations.mjs        → exit 1
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/dist/cliobservations.js'
  imported from …/test/cliobservations.mjs
ℹ tests 1  pass 0  fail 1

$ node test/picocli.mjs                        → exit 1
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/dist/cliobservations.js'
  imported from …/test/picocli.mjs
```

A module-not-found is a weak RED for the *behavioural* assertions, so the load-bearing ones were re-reddened against the finished build by mutating only the compiled behaviour (`dist/`), then restored with `npm run build`:

```
# watchedSec reverted to the requested window in dist/picoclitools.js
$ node --test --test-name-pattern='exits after 1 second|gave up waiting|early clean exit' test/cliobservations.mjs
✖ a 60 second request whose child exits after 1 second reports 1 second, not 60
  AssertionError: Expected values to be strictly equal:  actual: 60,  expected: 1,
✖ a CLI that gave up waiting for a process is never a clean no-crash window
  AssertionError: Expected values to be strictly equal:  actual: 60,  expected: 30,
✖ an early clean exit without a native timeout leaves coverage unknown
  AssertionError: Expected values to be strictly equal:  actual: 60,  expected: 1,

# watchAssessment reverted to ignoring coverage in dist/cliobservations.js
$ node --test --test-name-pattern='quiet window is only a no-crash answer|gave up waiting|truncated output is partial' test/cliobservations.mjs
✖ a quiet window is only a no-crash answer when coverage is complete
  AssertionError: Expected values to be strictly equal:
    actual: 'no-crash-detected',  expected: 'inconclusive',
✖ a CLI that gave up waiting for a process is never a clean no-crash window
  AssertionError: Expected values to be strictly equal:
    actual: 'no-crash-detected',  expected: 'inconclusive',

$ npm run build && node --test test/cliobservations.mjs   → restored, 20/20 green
```

The unscoped-grace failure quoted under "Deviation" is a third, unplanned RED: it is a real behavioural observation of the shipped build, not a fixture.

**GREEN** (final clean pass on the committed tree — build first, as `dist/` has no `pretest` hook):

```
$ npm run build                        → tsc clean
$ node --test test/cliobservations.mjs → exit 0   ℹ tests 20  pass 20  fail 0   (~4.4 s wall clock)
$ npm run test:picocli                 → exit 0   pico-cli lane Failures: 0 ; tests 157 pass 157 fail 0
$ npm run test:knowledge-lifecycle     → exit 0   ℹ tests 26  pass 26  fail 0
$ npm run test:doors                   → exit 0   Doors test done. Failures: 0
$ npm run test:prompts                 → exit 0   ℹ tests 3  pass 3  fail 0
$ npm run test:distribution-adoption   → tests 43 pass 41 fail 2   (the two documented baseline reds only:
                                          the gate-lane count and the `test:` script inventory, both
                                          named in AGENTS.md and in the C1/C2 reports; their inputs are
                                          byte-identical to f743b0b)
```

The brief's required argv assertion is present verbatim in `test/cliobservations.mjs`:

```js
assert.deepEqual(watchArgv("com.example.fixture", "fixture-serial", 60, true),
  ["app", "watch-crash", "com.example.fixture", "-d", "fixture-serial", "--monitor-timeout", "60"]);
```

### How the timing tests work (no sleeping for the window)

A fake child script is written to a temp dir and spawned by the **production** bounded runner (`runPicoCliCommand`), so exit codes, SIGTERM/SIGKILL escalation, output capping and truncation are all genuine. The injected `run` reports the production `timeoutMs` it was handed (asserted), then spawns that child with a *small real* bound (700 ms for the hang cases) and advances the injected monotonic clock by the scripted amount. A "60 second window" and an "80 second watchdog" therefore cost milliseconds of real time; the whole suite runs in ~4.4 s and exits promptly with no lingering timers.

Cases covered (all from the brief): requested 60 s with exit after 1 s; native timeout at 60 s; launch waiting without a process ("No running pid found … within 30s."); a stuck child hitting the watchdog (with and without a native timeout); a nonzero exit (`adb: device 'emulator-5554' not found`, exit 2); output truncation; a crash marker outside the returned UI tail (asserted to be absent from `outputTail` and present in the retained log). Plus: immutable retention with hash/byte verification and a refused overwrite; optional `--start`/`--activity`/`--interval` argv and no implicit launch; capability refusal with zero spawns for all four failure classes; and the retired description wording.

## Files changed

| File | Why |
| --- | --- |
| `src/cliobservations.ts` (new, 200 lines) | Pure coverage arithmetic, `watchArgv`, watchdog bound, the assessment rule, and the retained-CLI facts that justify them. |
| `src/picoclitools.ts` (+386/−…) | `watch_crash` rewritten: capability gate, native-timeout selection, outer watchdog, immutable retention, observed timing, honest assessment, updated description and typed output schema. |
| `src/picocli.ts` (+134) | Operation-conditional environment remedy; `retainPicoCliObservation` / `picoCliObservationRoot`. |
| `src/clicapabilities.ts` (+60) | `nativeDurationFlag` route fact and its accessor; `capabilityFailureClass` moved here from knowledge.ts. |
| `src/knowledge.ts` (10 lines) | Import the moved `capabilityFailureClass`; delete the local copy. Nothing else. |
| `test/cliobservations.mjs` (new, 415 lines) | The C3 suite (20 tests). |
| `test/picocli.mjs` (+57) | Route facts checked against the retained help bytes, the argv assertion, the moved failure-class map, the operation-conditional remedy, and the retired description wording. |

Untouched and verified byte-identical to `f743b0b`: `package.json`, `.gitignore`, `.github/**`, `scripts/**`, `test/distribution-adoption.mjs`, every doc carrying the byte-pinned policy block, `src/doors.ts`, `src/perfcli.ts`, `src/perftrace.ts`, `src/verifyapk.ts`, `src/capture.ts`, `src/preflight.ts`, and every SDK-track file.

## New test files needing CI registration

**`test/cliobservations.mjs`** — runs directly with `node --test test/cliobservations.mjs` (~4.4 s, no network, no CLI, no emulator). It needs, through the release track:

- a `package.json` script, e.g. `"test:cliobservations": "node --test test/cliobservations.mjs"`, and
- a matching lane in `.github/workflows/gates.yml`.

`test/distribution-adoption.mjs` asserts that every `test:` script appears in `gates.yml` (and asserts script counts), so the script and the lane must land together. No other new suite; everything else is in `test/picocli.mjs`, already wired through `test:picocli`.

## Self-review

- **Completeness.** Every brief checkbox and every controller resolution is covered, except resolution 3's unconditional grace — deliberately scoped, measured and escalated above. Resolution 1 (types + `assessCoverage` grading + `monitoredSec` null with a reason), 2 (capability + route-fact selection, never a version comparison alone), 4 (`watchedSec` kept but observed, `requestedDurationSec` and `ObservationCoverage` added, schema and description updated, code comment on the meaning change), 5 (immutable run-unique retention with sha256/bytes/truncation, scan over the complete retained log, `assessment:"inconclusive"` whenever coverage is not `complete`) and 6 (fake-child timing tests first, RED retained) are implemented as written.
- **Quality.** Pure arithmetic in `cliobservations.ts` (no fs, no spawn, no clock); fs conventions in `picocli.ts` next to the managed-store convention they mirror; the wrapper in `picoclitools.ts`. No second spawner — the existing bounded runner and its managed-integrity guards are reused unchanged.
- **Discipline (YAGNI).** No new package script, no docs touched, no `capture_record` changes, no new dependency, no restructuring of the large files beyond the watch handler. `ObservationCoverage` was kept to the brief's six fields; the explanatory sentence went into a separate `coverageNote` rather than growing the type.
- **The four specific checks.** *Early exit never yields the requested window as observed*: `watchedSec` is always `observation.elapsedSec`, and the 60 s-request/1 s-exit test asserts `watchedSec === 1` with `coverage: "partial"`. *No path spawns without a `supported` capability*: the gate returns before `runtime.run` is reachable, and the refusal test injects a `run` that throws if called, asserting zero spawns across all four classes. *The retained raw file is never overwritten*: non-recursive `mkdir` + `wx`, with a test that re-retaining a fixed `runId` returns `{retained:false}` and leaves the first bytes intact. *No implicit launch*: `--start` is pushed only when requested, asserted absent by default.
- **Testing.** Real fake child processes through the production runner; long windows come from the injected clock, never from sleeping. Output is pristine (no stray logging), the suite exits promptly, and the temp tree is removed in `test.after`.

## Concerns / notes for the controller

1. **The grace deviation above needs a yes/no.** It is the only place I did not follow a resolution literally.
2. **`capture_record` is still ungated.** It spawns without consulting `picoCliOperationCapability`, unlike `watch_crash` and the knowledge bridge. C6 owns that file's media validation; whoever takes it should add the same capability gate, and can reuse `capabilityFailureClass` and the refusal shape from `observeWatchCrash`.
3. **`perfcli.ts` / `perftrace.ts` remain ungated too** (C4), as C1 and C2 already noted.
4. **Observation run directories are never pruned.** Immutable by design, one directory per `watch_crash` call, a few KB each (bounded by the existing output cap). The capability store has the same property; a shared retention policy is a reasonable follow-up for the release track.
5. **`monitoredSec` stays `null` until a CLI line reports it.** If a future release prints the post-launch monitoring time, `assessCoverage` already accepts it and `MONITORED_WINDOW_UNAVAILABLE` is the single place to revise.
6. **The native-timeout decision is table-driven, per resolution 2.** A future line that removes `--monitor-timeout` would still inherit the 0.5.x fact until the table is updated (the unparseable-version guard only covers versions the table cannot place at all). Reading the flag out of the retained help *bytes* behind the capability would close that, at the cost of an fs read per call; I did not do it because resolution 2 specified the route table.
7. **`environment` refusals from a capability reason** pass `capability.reason` where raw stderr would go, because only the reason survives discovery — the same one-indirection caveat C2 recorded for the knowledge path.
8. **Evidence labelling.** `--monitor-timeout`'s existence, its default and its description are **help-observed** (retained bytes `0.5.0/096`, hash-verified by `test/picocli.mjs` against `RAW_HELP_INDEX_002.json`). The shared-deadline behaviour, the early returns and the 0.4.4 internal 30 s loop are **source-inspected** (byte-checked excerpts WATCH050 / WATCH_ARGS050 / WATCH044). Nothing here establishes runtime behaviour on a device or emulator: no watch was ever run against a real CLI, and `structural` remains the honest evidence class for a `watch_crash` result.

## Fix round 1 — never grade a watchdog-killed crash watch as complete

Reviewer finding (Important): a force-killed, completely silent child reported `coverage:"complete"` and `assessment:"no-crash-detected"`. `deriveCoverage` accepted any `endedBy` other than `cli-exit` once `elapsedSec >= requestedDurationSec`, and a killed child has **no exit code**, so the nonzero-exit guard never fired for it; `watchAssessment` then upgraded the empty indicator list to `no-crash-detected`. The finding is correct and the failure mode is the exact inversion this task exists to remove: **the strongest verdict produced from the weakest evidence.** On a line that *was* given `--monitor-timeout`, a watchdog kill means the CLI blew past its own deadline by the entire 20 s grace and never performed the end-of-window log collection WATCH050 charges to that same deadline. It was also self-inconsistent with the non-native branch, which capped the identical kill at `partial`.

### What changed (commit `1b38dad`)

- **`src/cliobservations.ts`**
  - `deriveCoverage` now ends `return reachedRequestedWindow && input.endedBy === "native-duration" ? "complete" : "partial";` — only the CLI ending the window **itself** can be complete. The comment records why a `watchdog` end is the weakest evidence and why the nonzero-exit guard cannot catch it.
  - New `observedOutputComplete(input)`: the `outputComplete` **input** answers only "the capture cap retained everything the child wrote", so the emitted record now reports `outputComplete:false` whenever `endedBy === "watchdog"` — a SIGKILL cut the stream regardless of the cap. `assessCoverage` computes it once and feeds the same value to `deriveCoverage`, so the two cannot diverge.
  - `assessCoverage`'s doc no longer says "its own duration, or our watchdog firing no earlier than the requested seconds".
  - `describeCoverage`: the `complete` sentence now says "ended it itself (`native-duration`)" and is annotated as reachable only for that end. The `partial` branch gained a watchdog clause — "this wrapper killed a child that had not settled: the CLI never ended the window itself, and its end-of-window log collection never ran … A killed child is the weakest evidence there is; silence here says nothing about what the CLI did or did not see."
  - `watchAssessment`'s doc records that a killed child is therefore always `inconclusive`. Its body needed no change: once the watchdog cannot reach `complete`, the existing rule produces `inconclusive` on its own.
- **`src/picoclitools.ts`** (one line, same inconsistency): the `status` schema description no longer calls a watchdog kill "the healthy end of a stuck child". It now reads "a watchdog kill of a stuck child is reported here too, but it is never graded `observation.coverage:'complete'`".

No other consumer was affected — `grep` confirms `assessCoverage` / `watchAssessment` / `no-crash-detected` appear only in `src/cliobservations.ts`, `src/picoclitools.ts` and the C3 suite. The ledgered Minor items were not touched.

### Covering tests

- `assessCoverage never calls an early or unbounded window complete` — the watchdog case flipped from `complete` to `partial`, and now also asserts `outputComplete === false` ("a SIGKILL cuts the stream whatever the capture cap did").
- `a stuck child is killed by the documented watchdog and reports observed elapsed time` — `coverage` `complete` → `partial`, `assessment` `no-crash-detected` → `inconclusive`. Observed elapsed time and the `duration-cap` prose are unchanged.
- **New:** `a watchdog-killed silent child is never graded complete or no-crash-detected` — the exact worst case, on a line that **was** given `--monitor-timeout`: a child that wrote zero bytes, blew through its deadline plus the whole grace and had to be SIGTERM/SIGKILLed. Asserts `nativeTimeoutSupported:true`, `endedBy:"watchdog"`, `coverage:"partial"` (and explicitly *not* `complete`), `outputComplete:false`, `crashIndicated:false`, `assessment:"inconclusive"` (and explicitly *not* `no-crash-detected`), the `(no output during the window)` tail, and that `coverageNote` no longer says "ran to the end" but does name the missing end-of-window log collection.

### Commands and output

RED (expectations updated first, run against the previous build):

```
$ node --test test/cliobservations.mjs                                   → exit 1   ℹ tests 21  pass 18  fail 3
✖ assessCoverage never calls an early or unbounded window complete
  AssertionError: Expected values to be strictly equal:  actual: 'complete',  expected: 'partial',
✖ a stuck child is killed by the documented watchdog and reports observed elapsed time
  AssertionError: Expected values to be strictly equal:  actual: 'complete',  expected: 'partial',
✖ a watchdog-killed silent child is never graded complete or no-crash-detected
  AssertionError: Expected values to be strictly equal:  actual: 'complete',  expected: 'partial',
```

GREEN (after the source fix, on the committed tree):

```
$ npm run build                        → tsc clean, EXIT=0
$ node --test test/cliobservations.mjs → EXIT=0   ℹ tests 21  pass 21  fail 0
$ npm run test:picocli                 → EXIT=0   pico-cli lane Failures: 0 ; tests 157 pass 157 fail 0
```

### Note for the release notes (extends the `watchedSec` entry above)

A `watch_crash` result whose `observation.endedBy` is `"watchdog"` is now always `coverage:"partial"` with `outputComplete:false` and `assessment:"inconclusive"`, on both CLI lines. Only `endedBy:"native-duration"` — the CLI ending its own `--monitor-timeout` window and exiting — can yield `coverage:"complete"`, and therefore only that end can yield `assessment:"no-crash-detected"`.
