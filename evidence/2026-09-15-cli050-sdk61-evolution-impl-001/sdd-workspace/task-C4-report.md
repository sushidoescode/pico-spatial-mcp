# Task C4 report — Align the perf command and report contract

Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-cli-2026-09-15` (branch `track/cli050-cli`, base `1b38dad` = C1+C2+C3 complete).
Status: **DONE**. Two commits, never pushed, never rebased. The git stash stack was never touched (0 entries throughout).

No emulator, no device, no MCP tool, no real `pico-cli`, no profiler, no `setup`, no `PICO_HOME`: every child in every new test is a fake CLI function driven through the production runtime seam, every long duration is synthetic, and every report is a labelled synthetic fixture or retained bytes.

## Commits

| SHA | Subject | Files |
| --- | --- | --- |
| `f41fb8e` | `fix: dispatch pico-cli perf live run from capability evidence and validate its report` | `src/clicapabilities.ts`, `src/perfcli.ts`, `src/picocli.ts`, `src/doors.ts`, `src/spatialbench.ts`, `test/spatialbench.mjs`, `test/helpers/picocli-managed-fixture.mjs`, `test/fixtures/picocli/synthetic/**` (8 new files) |
| `a57f438` | `fix: parse profiler trace load/query envelopes` | `src/perftrace.ts`, `test/picocli.mjs` |

Both messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Commit 1 was built and its suites run **in that reduced state** before committing (157/157 picocli, bench 0 failures, doors 0 failures), so the intermediate commit is not a broken tree. The whole C4 test block lives in `test/picocli.mjs` and therefore lands with commit 2 — one file cannot be split across two commits, and the perf-side implementation in commit 1 is separately covered by the `test/spatialbench.mjs` block it ships with.

`git diff --name-only 1b38dad HEAD` lists exactly the 17 owned files. `package.json`, `.gitignore`, `.github/**`, `scripts/**`, `test/distribution-adoption.mjs`, `test/picocli-autoinstall.mjs`, every doc, `src/knowledge.ts`, `src/picoclitools.ts`, `src/verifyapk.ts`, `src/capture.ts`, `src/preflight.ts` and every SDK-track file are byte-identical to `1b38dad`. The `src/doors.ts` hunk is local to the perf-axis region (lines ~989–1012); lines ~474–475 are untouched.

## What was implemented

### 1. `src/clicapabilities.ts` — per-route option facts (+107 lines)

`CliOperationRoute` gains `options: CliRouteOptions | null` (`{names: Record<role, flag>, provenance}`) and the accessor `cliOperationOptions(version, operation)`. Like `cliOperationNativeDurationFlag`, an unparseable version answers `null` rather than inheriting the newest table, because an option spelling is a positive claim nothing would judge.

The spellings belong to the **vendored profiler**, not to pico-cli: 0.4.4 bundles `pspp-profiler-cli-0.1.0.tgz`, 0.5.0 bundles `pspp-profiler-cli-0.2.0.tgz`. Both nested archives were read in memory (Python `tarfile`, nothing extracted, nothing executed):

| Route | 0.4.x (profiler 0.1.0) | 0.5.x (profiler 0.2.0) |
| --- | --- | --- |
| `perf-live` | no route (unchanged from C1) | `--package`, `--duration`, `--device`, `--save`, `--output` |
| `trace-record` | `--app`, `--duration`, `--device`, `--output` | `--package`, `--duration`, `--device`, `--output` |
| `trace-decode` | `--format`, `--output` | same |
| `trace-load` | `--envelope` | same |
| `trace-query` | `--session`, `--sql`, `--envelope` | same |

`verifyOperationCapability` passes `options: null` when it re-classifies stored bytes — the dispatch-time spellings are read from the live table, never from a stored record.

### 2. `src/perfcli.ts` — capability-gated dispatch + a validated report adapter

`collectPerfLive(request, runtime)` is exported with a `PerfDiagnoseRuntime` seam (`capability`, `rediscover`, `options`, `familyEvidence`, `run`, `retain`, `cliPath/cliRaw/cliVersion`). `runPerfDiagnose(packageName, opts)` keeps its exact signature and builds the production runtime. Flow:

1. **Capability gate.** `picoCliOperationCapability(cli, "perf-live")` must be `supported` with a non-empty route. `unknown` **with no usable evidence** (`capabilityNeedsFreshDiscovery`) triggers exactly **one** bounded rediscovery through `ensurePicoCli({forceRefresh:true})`, exactly as C2 does, and is then re-resolved. Anything else refuses **without spawning**, carrying `failureClass`, the verbatim capability reason, `argvPrefix` and the retained bounded-help evidence paths. `setup-required` returns the byte-pinned `SETUP_REQUIRED_NOTE` plus `setupCommand`; `environment` returns `describePicoCliEnvironmentFailure(reason, "", "perf-live")` and never prescribes setup.
2. **Argv completeness.** A `supported` route whose line declares none of the needed roles refuses as `flag-or-version-drift` rather than dispatching a half-built argv.
3. **Immutable output.** `statSync` before the run; a path that already exists is refused (size + mtime quoted) — it can neither be attributed to this run nor be overwritten without destroying prior evidence.
4. **Bounded run** through the existing `runPicoCli` boundary (no second spawner), then the report bytes are read and **both the raw streams and the whole raw report** are retained immutably.
5. **Validated adaptation.**

`perfLiveArgv` emits `--output` only together with `--save`, because `LiveRunAction.execute` refuses an unpaired explicit output and `--save` alone would write the profiler's own `reports/live-report-<ISO>.json` instead of our evidence path.

`adaptPerfReport({raw, readError, requestedPackage, requestedDevice, producerVersion, preexisting})` is pure. It returns `{status, measurement, reportVersion, producerVersion, reason, view, missingCounters, …}`:

- **Schema identification** comes from the only key that distinguishes the two published schemas — `metadata.package` (0.2.0) vs `metadata.app` (0.1.0). *Neither report carries a version field*, so there is nothing else to read. No match → `failed`.
- **Identity**: the reported package must equal the request (an empty package is called out as the profiler's `--package none` no-app-metrics mode). Neither schema declares a device field, so `metadata.device|deviceId|serial` is validated only **when present** — an absent one is not a mismatch.
- **Missing / empty `{}` / malformed / truncated / unknown schema / mismatched identity / pre-existing file** → `failed`, `measurement:"missing"`, never `ok`.
- **Grading**: `missing` when the diagnosis is `SKIP`/`INSUFFICIENT_DATA` or appFps is absent/zero; `partial` when app FPS was measured but a declared counter group is absent **or all-zero**; `complete` otherwise. An all-zero group is reported in `missingCounters` — "not measured", never "measured zero" and never "GPU idle".
- **`view`** is bounded: metadata, diagnosis, summary, jank count + the top 5 windows. The unbounded per-sample `rawData` array is excluded. The legacy top-level `metadata`/`diagnosis`/`summary`/`jankWindowCount`/`jankWindows` fields are still populated with the same values, so `doors.ts` and SpatialBench needed no consumer rewrite.

`scorePicoCliPerfAxis` keeps its signature and its documented boundaries, and additionally returns `null` for an explicit `measurement:"missing"`. `measurement` is optional, so an older result object without it still scores.

### 3. `src/perftrace.ts` — validated trace contracts

Extracted `runPerfTrace(request, runtime)` with a `PerfTraceRuntime` seam; the tool handler builds the production runtime. Every action is capability-gated and argv-completeness-gated the same way perf live is, and every action retains its raw streams plus the session/report identity it was asked for.

- **`load`** now requests the machine envelope. `--envelope` is a **global program option** on both profiler lines and commander is configured with neither `allowUnknownOption` nor `passThroughOptions`, so `traceArgv` places it immediately after `perf`: `["perf","--envelope","trace","load",<file>]`. The 0.5.0 router's subcommand extractor skips leading flags, so `trace`/`load` is still what it validates. `validateTraceLoadEnvelope` checks `success && resource==="trace" && action==="load" && data.sessionId`. A failure envelope, a wrong action or a missing id yields **no id at all**.
- **Legacy path**, separately identified: `parseTraceLoadHumanSession` matches the exact `[TraceLoad] Session: <id>` line and nothing else, and the result is reported as `sessionSource:"legacy-human-label"` with a note. It is used only when the envelope was unusable. `parseTraceSessionId` survives as an inert compatibility export (its existing tests still pass) and has no production call site.
- **`query`** validates `success`/`resource`/`action`/`sessionId` and then returns `data.rows`. An empty successful array is a measurement; `success:false` keeps exit/error metadata; empty, malformed, truncated or wrong-session output fails with the raw output preserved and **no `rows` key at all**.
- **`record`/`decode`** keep the argv that still matches the declarations, spelled with explicit long options from the per-line facts. No new trace-analysis execution was added.

### 4. `src/picocli.ts` — artifact retention + the profiler-entry reconciliation

- `retainPicoCliObservation` gains an optional `artifacts: [{name, bytes, sourcePath}]` input, written with the same non-recursive `mkdir` + `wx` + fsync rules as the streams, recorded in `observation.json`, and returned as `retained.artifacts`. A name containing a path separator is refused. `collectPerfLive` uses it to copy the entire raw report into the run directory as `live-report.json`; `rawReportPath` then points at that immutable copy.
- `describePicoCliEnvironmentFailure`'s perf branch now names `PICO_CLI_PROFILER_ENTRY_PATH` as the CLI's documented explicit alternative (its resolver honours it **before** reading `PICO_HOME` at all) and states that the root this server resolves for its own SDK build/emulator lanes is a separate selection. It still never prescribes setup.

### 5. `src/doors.ts` (8 lines) and `src/spatialbench.ts` (11 lines)

The doors perf criterion treats `measurement:"missing"` as `unmeasurable` alongside the existing appFps checks, and `perfTrail` now carries `measurement` and `missingCounters`. SpatialBench's note for a null pico-cli score names the measurement, the report schema and the unmeasured counters, and says explicitly that the gfxinfo fallback **is not an app 3D-FPS measurement**.

### 6. Test infrastructure

- `test/fixtures/picocli/synthetic/` (new): a `README.md` naming the exact archive members, hashes and schema facts every fixture encodes; six `live-report-*.json` fixtures (0.2.0 complete / SKIP / runtime-FPS-without-app-frames / wrong-package, 0.1.0 complete, unknown-schema); and `fake-perf-cli.mjs`.
- `fake-perf-cli.mjs` reproduces, from the same in-memory reads, the 0.5.0 router allow-list and its `Unknown perf subcommand: …` rejection, `LiveRunAction`'s `--package`-required / `--output`-requires-`--save` / `--envelope`-requires-`--duration` validation, and the utilities and `PICO_HOME` gate texts. It records every argv and writes the report **only** when the supported save/output arguments were passed.
- `test/helpers/picocli-managed-fixture.mjs` (two behavioural fidelity fixes, both additive in spirit): under `FAKE_PICO_OPERATION_MODE="setup-required"` a `perf … --help` probe now fails at the utilities gate (exit 1 on a 0.4.x fixture, 3 otherwise) exactly as the retained observations show (0.4.4/012 exit 1; 0.5.0/137–141 exit 3), while every other route's help still succeeds; and the empty/directory-artifact branch now honours `--output` as well as `-o`, because the real CLI declares them as one option.

## The one design decision that needed judgement

**A 0.4.x line has no live route, and `test/distribution-adoption.mjs` (which I may not edit) calls `perf_diagnose` against a 0.4.2 managed fixture and demands `failureClass:"setup-required"` with the byte-pinned neutral note.** Implemented literally, the capability gate returns `no-route:` → `cli-unusable` → a different note, and that test goes red. I measured it rather than assuming: baseline green, then red with the exact assertion diff.

Three escape routes were rejected: adding a 0.4.x `perf-live` route (pinned `no-route` by `test/picocli-autoinstall.mjs:2340-2349`, also unowned), changing the harness's default `latestVersion` (the same test's freshness scenarios depend on 0.4.1/0.4.2), and editing the adoption test.

What I shipped instead is grounded in the retained source: **PERF_ENV044's `ms()` and PERF_ENV050's `Tm()` resolve the perf utilities gate ONCE, before delegating any perf argv**, so a gate answer retained for a sibling `perf trace <op>` route is direct evidence about `perf live run` on the same package. When `perf-live` has no route, `collectPerfLive` adopts that family gate answer (`utilities-not-installed:` / `environment:`) and reports the CLI's own reason; with no family evidence it reports `flag-or-version-drift` and never `setup-required`. Both branches are pinned by tests. The fixture change above is what makes the family evidence exist in the adoption harness, and it is a fidelity *improvement*: the old generic fallback had `perf trace record --help` succeeding on a host where the perf payload is missing, which the retained bytes contradict.

`test/distribution-adoption.mjs` is green on that test again, honestly.

## TDD evidence

**RED** (both test blocks written before any implementation, run against the C3 build; saved under the session scratchpad `red/`):

```
$ npm run test:picocli                        → exit 1
  ok   watch_crash description states the observed-window contract instead of the retired claim
test/picocli.mjs:513
const live050Options = cliOperationOptions("0.5.0", "perf-live");
TypeError: cliOperationOptions is not a function

$ npm run test:bench                          → exit 1
  ok   bench perf axis: the documented scorePicoCliPerfAxis null boundaries still hold
test/spatialbench.mjs:820
const adaptSynthetic = (name) => adaptPerfReport({
TypeError: adaptPerfReport is not a function
```

Note the second RED is informative rather than trivial: the *pre-existing* score boundary assertion passed against the old build (proving the boundary contract was preserved from the start), while the new adapter-driven assertions could not even resolve.

A third, unplanned RED is the one quoted under "The one design decision" — a real behavioural observation of the first honest implementation against `test/distribution-adoption.mjs`, not a fixture:

```
✖ setup-required wrapper results stay source/freshness-neutral and never execute setup
  registry latest/perf_diagnose: actual 'flag-or-version-drift' - expected 'setup-required'
  note: "pico-cli offers no verified live-collection route (installed: pico-cli/0.4.2 …)"
  capability.reason: "no-route: 0.4.x: no 0.4.x live-collection route is dispatched: …"
```

Two more reds surfaced during implementation and are worth recording:
- `report adapter mismatched package wrong: reportVersion "0.2.0"` — my fixture expectation was wrong, not the code: `metadata.package` **is** present, so the schema line is identified and only the identity check fails. The test was corrected (and now documents why).
- `exit-zero empty/directory capture and trace artifacts are runtime failures` in `test/picocli-autoinstall.mjs` went red after the trace wrappers moved to `--output`, because the runtime fixture only looked for `-o`. Fixed in the fixture helper, where the real CLI's `-o, --output` declaration says it belongs.

**GREEN** (final clean pass on the committed tree — build first, as `dist/` has no `pretest` hook):

```
$ npm run build                        → tsc clean
$ npm run test:picocli                 → exit 0   171 ok / 0 FAIL ; tests 157 pass 157 fail 0
$ npm run test:bench                   → exit 0   79 ok ; SpatialBench Failures: 0
$ npm run test:doors                   → exit 0   Doors test done. Failures: 0
$ npm run test:prompts                 → exit 0   tests 3 pass 3 fail 0
$ node --test test/cliobservations.mjs → exit 0   tests 21 pass 21 fail 0
$ npm run test:knowledge-lifecycle     → exit 0   tests 26 pass 26 fail 0
$ npm run test:preflight               → exit 0   Preflight test done. Failures: 0
$ npm run test:distribution-adoption   → tests 43 pass 41 fail 2  (the two documented baseline reds
                                          only: the gate-lane count and the `test:` script inventory,
                                          both named in AGENTS.md and in the C1/C2/C3 reports; their
                                          inputs are byte-identical to 1b38dad)
```

The brief's required assertions are present **verbatim**:

```js
// test/picocli.mjs
assert.deepEqual(capturedRun.args, ["perf", "live", "run", "--package", "com.example.fixture",
  "--duration", "15", "--device", "fixture-serial", "--save", "--output", reportPath]);

assert.equal(scorePicoCliPerfAxis({status: "ok", summary: {}}, 16.7).perf, null);
assert.equal(scorePicoCliPerfAxis({status: "ok", summary: {appFps: {p5: 0, avg: 0}}}, 16.7).perf, null);

const queryEnvelope = {success:true, exitCode:0, resource:"trace", action:"query",
  data:{sessionId:"fixture-session", rpcEndpoint:"http://127.0.0.1:19001", rows:[{value:1}]}};
assert.deepEqual(validatedQueryResult.rows, queryEnvelope.data.rows);
assert.notDeepEqual(validatedQueryResult.rows, queryEnvelope);
```

(the two score assertions also appear verbatim in `test/spatialbench.mjs`.)

### New coverage (all inside existing suites — no new package script, nothing to register in CI)

`test/picocli.mjs` (+468 lines): route option facts per line; the verbatim argv; report retention (whole report + both streams, with the source path recorded); zero `monitor` in any dispatched argv; the fake CLI's router rejection classified as drift; capability refusals for setup-required / environment / no-route-with-family-evidence / no-route-without / unknown-then-one-rediscovery; the argv-completeness guard for perf and trace; stale pre-existing output; exit 0 with no report; ten report-adapter cases (missing, `{}`, malformed, truncated, unknown schema, mismatched package, 0.2.0 complete, 0.1.0 complete, SKIP, runtime-FPS-without-app-frames) plus preexisting, bounded-view, missing-counters and both device-field cases; the score boundaries and measurement propagation; query envelope success, empty rows and eight failure cases; load envelope success and five failure cases; the legacy label parser and its refusal of prose; five `traceArgv` shapes; and `runPerfTrace` load/query/refusal/truncation.

`test/spatialbench.mjs` (+37 lines): the boundary assertions, plus SKIP, runtime-FPS-only, 0.2.0-complete and 0.1.0-complete scoring through the real adapter.

## Evidence labelling

- **Source-inspected** (official tarballs read in memory, never extracted, never executed):
  - `picoxr-pico-cli-0.5.0.tgz!package/dist/index.js:36–37` — router allow-list, `lC()` validating the subcommand **before** `Tm()` resolves the profiler entry, `{stdio:"inherit"}` delegation (`PERF_ROUTER050` / `PERF_ENV050`).
  - `…!package/vendor/profiler-cli/pspp-profiler-cli-0.2.0.tgz` (sha256 `9e78d481…0eac85d`) `package/dist/index.js:2` — `LiveRunAction` (`LIVE050`), `TraceRecordAction`/`TraceDecodeAction`/`TraceLoadAction`/`TraceQueryAction` `registerOptions`, `renderTraceLoad` (`TRACE_LOAD_HUMAN`), `buildJsonEnvelope`/`shouldEmitEnvelope`/`writeOutput` (`TRACE_JSON_ENVELOPE`), `resolveLiveReportOutputPath`, `createProgram()`'s global `--envelope` and the absence of `allowUnknownOption`/`enablePositionalOptions`/`passThroughOptions`.
  - `…!pspp-profiler-cli-0.2.0.tgz!package/dist/src/live/reporter.d.ts` (2245 bytes, sha256 `9d0e2c33…6636e5cb`) and `package/dist/src/core/types/context.d.ts` — the full `ReportData` and `JsonEnvelope` declarations. **There is no `device` field and no version field in either report schema, and no `appFps.p95` on either line.**
  - `picoxr-pico-cli-0.4.4.tgz!…pspp-profiler-cli-0.1.0.tgz` (sha256 `13d029ef…4a0cfe2`) — the 0.1.0 counterparts (`--app` required on live, `-a, --app` on record, `--session`/`--sql` both required on query, no `outputMode`, the same global `--envelope`).
- **Help-observed (retained bytes):** unchanged from C1 — the capability classifications that the gate consumes (`0.4.4/012` exit 1; `0.5.0/137–141` exit 3; the exit-0 helps for the non-perf routes). `test/picocli.mjs` still hash-verifies every fixture against `RAW_HELP_INDEX_002.json` on each run.
- **Source-derived strings (constructed from retained templates, not observed):** the fake CLI's `Unknown perf subcommand: …`, `Missing required option: --package …`, the `--output`-requires-`--save` sentence, the utilities-gate and `PICO_HOME` texts. Labelled as such in the fixture README and in code comments.
- **Synthetic fixtures:** every `live-report-*.json`, clearly marked, under a `synthetic/` subdirectory with a README naming the published schema each was built from.
- **Fixture-tested:** every behaviour above, through the production code paths.

### Not established (unchanged limits, stated plainly)

- **Provisioned profiler help was never observable on this host**, so no route in the perf family has a positive retained exit-0 help example, and `exitZeroHelpObserved:false` still stands for all of them. Nothing here proves a provisioned `perf live run --help` renders a usage line naming the route.
- **No native sampling, no device, no emulator.** No profiler ever ran; no report was ever produced by a real profiler. The 0.2.0/0.1.0 report shapes are declaration-derived.
- Semantic compatibility, end-to-end trace collection, traceconv availability, daemon/`trace_processor_shell` behaviour, Windows behaviour, and any visual evidence remain unproven. `structural` is the honest evidence class for every result this task touches.

## Self-review

- **Completeness.** Every brief checkbox: both audits and the exact vendored options read ✓; `PICO_HOME` vs explicit profiler-entry reconciled in the remedy and kept separate from SDK tools-root selection, with no guessed root ✓; fake CLI rejecting `monitor`, capturing argv, writing the 0.2.0 report only on save/output ✓; the verbatim argv assertion ✓; missing file / empty `{}` / malformed / truncated / mismatched package / mismatched device-when-present / stale pre-existing output / unknown report version / `SKIP` / `INSUFFICIENT_DATA` / missing counters ✓; the score boundary verbatim ✓; capability-based argv and a validated adapter per supported report version, whole raw report retained with a hash, producer version and input identity, bounded view, unavailable vs failed distinguished ✓; `load --envelope` + validated `data.sessionId`, `query` unwrapping `data.rows` after identity checks, legacy parsing separately identified with a fixture built from the exact retained label ✓; load/query regressions for success, `success:false` with exit/error metadata, empty, malformed, truncated, wrong session and legacy output ✓; record/decode argv kept and raw streams + identity captured ✓; missing/partial propagated into SpatialBench and doors acceptance, never a pass ✓; build + the three named suites + the affected doors fixtures ✓; the limit retained rather than papered over ✓. All five controller resolutions followed, including the TDD order.
- **Quality.** Dispatch + adapter in `perfcli.ts`, trace contracts in `perftrace.ts`, route/capability facts in `clicapabilities.ts`, scoring in its existing module, the doors hunk minimal and local. No second spawner; the existing bounded runner and managed-integrity guards are reused unchanged. Two correctness issues found in my own self-review and fixed before committing: `cliPath`/`cliRaw`/`cliVersion` became accessors so a mid-call rediscovery cannot make a refusal quote a package we did not run, and an incomplete option-fact set now refuses instead of dispatching a half-built argv (both pinned by tests).
- **Discipline (YAGNI).** No new trace-analysis tool despite `TRACE_ANALYSIS050` advertising seven; no `--envelope` on `live` (the brief's argv assertion settles it, and it would suppress the progress stream); no new package script; no docs touched; no restructuring beyond extracting the two cores behind their runtime seams.
- **Testing.** No process is spawned by the new tests — `test/picocli.mjs`'s "spawns NO MCP server and NO pico-cli" header remains true — while the real spawn path for these wrappers stays covered by `test/distribution-adoption.mjs` and `test/picocli-autoinstall.mjs` against fake managed children. Output is pristine, the temp tree is removed, and no fixture process lingers (the `pico-cli` processes visible on this host are the user's pre-existing plugin MCP servers, started hours before this session).
- **The four required checks.** *No path spawns `perf monitor`*: `grep -rn 'monitor' src/` finds it only in prose/comments and in two unrelated word lists; `test/picocli-autoinstall.mjs` additionally asserts no ledger argv matches `/\bmonitor\b/`, and a C4 test asserts it over the dispatched argv. *No path sets `PICO_HOME`*: there is no `PICO_HOME =` assignment anywhere in `src/`; the only writes to any env are none. *A SKIP/INSUFFICIENT_DATA report can never score as passing*: `measurement:"missing"` short-circuits `scorePicoCliPerfAxis` to `null`, the doors criterion to `unmeasurable`, and SpatialBench to a disclosed non-score — each pinned by a test. *Stale pre-existing output is refused*: `statSync` before the run returns `failed`/`missing` with zero spawns, asserted.

## Concerns / notes for the controller

1. **The `no-route` family-gate branch is the one place I added machinery the brief did not name.** It is source-grounded (one utilities gate per perf family, resolved before any delegation) and it is what keeps `test/distribution-adoption.mjs` honest-and-green on a 0.4.x line. If the controller prefers the literal reading — `no-route` always reports drift — that is a two-line deletion in `collectPerfLive`, but the adoption test then needs the release track to relax its `perf_diagnose` row.
2. **`test/helpers/picocli-managed-fixture.mjs` changed behaviour, not just shape.** Two changes: perf `--help` now fails under `setup-required` mode, and the artifact branch honours `--output`. Only `test/distribution-adoption.mjs:704` and `test/picocli-autoinstall.mjs:2183` use that mode, and both are green; but a parallel track adding a perf-route help expectation to the runtime harness should know.
3. **`--envelope` placement is load-bearing and untested against a real CLI.** It must precede the resource token because the profiler's commander has no `passThroughOptions`. The 0.5.0 router's flag-skipping extractor accepts it, by source. If a provisioned profiler ever rejects `perf --envelope trace load …`, the wrapper degrades to the legacy label path for `load` and to a structured failure for `query` — no crash, no wrong claim.
4. **`trace query --execute` is not wrapped.** Its data is `{sessionId, rpcEndpoint, executed:true}` with no `rows`, and the validator says so in its refusal reason. Adding it would be a new capability, not a fix.
5. **`parseTraceSessionId` is now dead in production** but still exported and still tested, because its existing assertions are in `test/picocli.mjs` and other consumers may hold it. Whoever owns the next surface sweep can retire it.
6. **Observation run directories still are not pruned** (C3's note 4 applies to `perf-live` and the four trace operations too, and each perf run now also stores a copy of the report — a few KB to a few hundred KB each).
7. **`reportVersion` is the profiler's report schema, `producerVersion` the resolved pico-cli version.** The bundled profiler's own version is not recoverable from the report, so it is not claimed.
8. **`test/cliobservations.mjs` still needs a `package.json` script and a `gates.yml` lane** (C3's open item; unchanged by this task). Nothing C4 added needs CI registration.

## Fix round 1 — disclose the probed perf-live capability beside the family gate

Reviewer finding (Important), confirmed and correct: `src/perfcli.ts:392-420` let the adopted
family gate **replace** the disclosed capability (`const classified = family ?? capability`, then
`capability: capabilityDisclosure(classified)`). On a 0.4.x line `perf_diagnose` therefore returned
`capability.operation:"trace-record"`, `capability.argvPrefix:["perf","trace","record"]` and the
trace-record reason, while perf-live's own `no-route: 0.4.x: no 0.4.x live-collection route is
dispatched…` reason appeared **nowhere** in the returned object. Paired with the byte-pinned setup
note (`test/distribution-adoption.mjs:727`) and `src/doors.ts:89-93`, which converts a
`setup-required` perf outcome into manual setup guidance, a caller was told to provision a payload
and retry an operation this repo's own route table says cannot run on that line even afterwards —
a silent over-claim about remediation, on top of an evidence field naming the wrong operation.

This is the same failure mode C3's fix round removed from `watch_crash`: the strongest-sounding
answer assembled from evidence that was about something else. My own self-review missed it because
I checked *which class* the family gate produced and never checked *what the result said it had
probed*.

### What changed (commit `9726a84`)

- **`src/perfcli.ts`**
  - `capability` is now always `capabilityDisclosure(capability)` — the operation this wrapper
    actually probed (perf-live), with its own reason, state and `argvPrefix` (null on a no-route
    line). New exported `PerfCapabilityDisclosure` type, shared by both fields.
  - New `familyGate?: PerfCapabilityDisclosure`, emitted only when a sibling gate was adopted. Its
    doc comment says what it is: evidence about the shared utilities payload, never about the live
    route.
  - New `remediationLimit?: string` (`NO_LIVE_ROUTE_LIMIT`), emitted on **both** no-route branches:
    "The resolved pico-cli line advertises no live-collection route at all (perf-live resolved as
    no-route), so provisioning the missing utility payload would still leave this wrapper without a
    route to dispatch here; the adopted failure class comes from a sibling perf route's own gate
    (familyGate) and is evidence about the shared payload, not about the live route. Live
    collection is routed on the 0.5.x line." It is deliberately a separate, non-pinned field — the
    setup sentence is byte-pinned and source/freshness-neutral, so the limit cannot be folded into
    it. The constant's comment records that reasoning.
  - `classified` was renamed `gateSource` and is now used **only** to derive the failure class and
    the environment remedy, i.e. from the gate that actually observed the condition. The
    byte-pinned note text is untouched. The no-route predicate was hoisted to `noRoute` so both the
    class choice and the limit read the same fact.
  - Typed `outputSchema`: `capability`'s description now says "ALWAYS for the operation this
    wrapper probed (perf-live)", plus descriptions for `familyGate` and `remediationLimit`. None of
    the new text contains the literal `pico-cli setup`, so
    `assertNoActionableBareSetup`'s scan over the public tool schemas stays clean.

- **`test/picocli.mjs`** — three assertions extended/added:
  1. the family-gate branch: `capability.operation === "perf-live"`, `/^no-route:/` on its reason,
     `capability.argvPrefix === null`, `familyGate.operation === "trace-record"` with
     `/^utilities-not-installed:/` and `["perf","trace","record"]`, and both halves of the limit
     sentence;
  2. the no-family drift branch: perf-live disclosure, `familyGate === undefined`,
     `setupCommand === undefined`, and the limit present;
  3. the evidence-backed gate: perf-live disclosure with neither `familyGate` nor
     `remediationLimit` (an observed perf-live gate needs no sibling answer and claims no limit).

### RED for the fix (re-reddened against the pre-fix behaviour)

`dist/perfcli.js` was patched back to the single-field shape, the suite run, then restored with
`npm run build`:

```
$ python3 …  # dist/perfcli.js: capability: capabilityDisclosure(family ?? capability)
$ node test/picocli.mjs
  FAIL family-gate disclosure wrong: {"capability":{"operation":"trace-record","state":"unavailable",
       "reason":"utilities-not-installed: `perf trace record --help` exited 1 at the CLI's utilities gate",
       "argvPrefix":["perf","trace","record"],"evidence":[]}}
  FAIL no-route drift classification wrong: {… "capability":{"operation":"perf-live",…} …}
       (familyGate/remediationLimit absent)
$ npm run build && node test/picocli.mjs   → pico-cli lane test done. Failures: 0
```

The first line is the reviewer's finding reproduced verbatim as a test failure.

### GREEN

```
$ npm run build                        → tsc clean
$ npm run test:picocli                 → exit 0   173 ok / 0 FAIL ; tests 157 pass 157 fail 0
$ npm run test:doors                   → exit 0   Doors test done. Failures: 0
$ npm run test:bench                   → exit 0   SpatialBench test done. Failures: 0
$ node --test --test-name-pattern='setup-required wrapper results|public schemas and missing-vault' \
      test/distribution-adoption.mjs   → exit 0   tests 2 pass 2 fail 0
```

`test:bench` and the two adoption cases were run beyond the requested pair because the returned
object shape changed: the byte-pinned setup note and the public-schema setup scan both still pass.

Commit `9726a84` — *fix: disclose the probed perf-live capability beside the family gate*, two files
(`src/perfcli.ts`, `test/picocli.mjs`), trailer `Co-Authored-By: Claude Fable 5.1
<noreply@anthropic.com>`. Never pushed. The ledgered Minor items were not touched.
