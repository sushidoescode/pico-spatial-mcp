# Task C1 report — Retain capability evidence and classify operations truthfully

Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-cli-2026-09-15` (branch `track/cli050-cli`, base `4478238`).
Status: **DONE** (one documented concern list below; nothing half-done).

## Commits (never pushed)

| SHA | Subject | Files |
| --- | --- | --- |
| `8aed3b2` | test: capture retained pico-cli 0.4.4/0.5.0 help bytes as fixtures | `test/fixtures/picocli/help/**` (73 files: 24 invocations × json/stdout/stderr + `index.json`) |
| `9257bfd` | fix: classify pico-cli operations from retained capability evidence | `src/clicapabilities.ts` (new), `src/picoclimanaged.ts`, `src/picocli.ts`, `src/preflight.ts`, `test/helpers/picocli-managed-fixture.mjs`, `test/picocli.mjs`, `test/picocli-autoinstall.mjs`, `test/preflight.mjs` |
| `01b009a` | ci: retain comparator raw outputs and expose partial help coverage | `scripts/compare-picocli-surfaces.mjs`, `.github/workflows/picocli-compat.yml`, `test/picocli-sweep.mjs` |
| `d938c74` | ci: drive the Windows emulator probe from the validated managed CLI | `scripts/probe-windows-emulator.mjs`, `.github/workflows/windows-emulator-probe.yml`, `test/windows-emulator-probe.mjs` |

Every commit message ends with the required `Co-Authored-By` trailer. `package.json`, `package-lock.json`, `.gitignore`, `gates.yml`, `run-battery.mjs`, `verify-tarball.mjs`, `test/distribution-adoption.mjs`, every doc carrying the byte-pinned policy block, and the C2/C3/C4-owned sources are untouched (verified with `git diff` against HEAD for the gate inputs).

## What was implemented

### 1. `src/clicapabilities.ts` (new) — types, routes, classification, stale checks
- The brief's types verbatim: `CliOperation`, `HelpObservation`, `OperationCapability`, `CliCapabilityIdentity`, `CliCapabilitySet`.
- Version-line route tables (`cliOperationRoutes(version)`): 0.4.x → `mcp dev-knowledge`, `app watch-crash`, `capture record`, `perf trace {record,decode,load,query}`, `perf-live` = no route; 0.5.x (and every newer line, probed with the newest retained table) → `knowledge server`, `app watch-crash`, `capture record`, `perf live run`, `perf trace {…}`. Each entry cites its evidence (retained invocation numbers 062/136/025/096/026/097/012/139/141 and excerpts K044/K050/WATCH_ARGS050/CAPTURE_ARGS050/PERF_ROUTER050/PERF_ENV050/PERF_ENV044) in the code comment beside the table. No table contains `perf monitor run`, a colon alias, or the removed spaced `mcp dev-knowledge` on 0.5.x.
- `classifyHelpOutput`: pure. Nonzero exits are read through their text → `unavailable` with `utilities-not-installed:` / `environment:` / `unknown-command:` / `nonzero-exit:` prefixes; exit-zero output must contain a usage section **and** name the exact operation phrase → `supported` (`help-names-operation:`), else `unavailable` (`generic-parent-help:`) or `unknown` (`malformed-help:`); timeouts, truncation and incomplete processes are `unknown` (`timed-out:`/`output-truncated:`/`incomplete:`). Reason strings carry a stable prefix so consumers can branch on it.
- `classifyOperation`, `capabilityCoverage` (`complete` only when every operation is terminal), `sameCliCapabilityIdentity` + `describeIdentityDrift` (all four identity fields), `cliCapabilityIdentityKey`, `verifyOperationCapability`/`verifyCapabilitySet` (re-read bytes, sha256-verify, re-classify, require the stored state to be reproduced), `resolveOperationCapability` (the only path to a dispatch decision: `no-discovery:`, `stale-identity:`, `evidence-missing:`, `evidence-mismatch:`, `report-inconsistent:` → `unknown`), `parseCliCapabilitySet` (strict schema-1 reader). Shared regexes (`PICO_CLI_UTILITIES_GATE_PATTERN`, `PICO_CLI_ENVIRONMENT_PATTERN`, `PICO_CLI_USAGE_DRIFT_PATTERN`) so `picocli.ts` and the comparator classify with one source of truth.

### 2. `src/picoclimanaged.ts` — bounded discovery, immutable persistence, identity
- Removed `COMPATIBILITY_CANARIES`, the staging canary loop, `compatibility.json` writing and `hasCompleteCompatibility`; activation (`validateLatestPublishedVersion`, `validateOwnedUnfinalizedVersion`) no longer depends on a canary report. `readCompatibility` stays as the documented versioned reader for legacy schema-1 files and still surfaces as `result.compatibility` (tested).
- Identity: managed = `{version, executablePath: canonical shim, packageJsonSha256: sha256(node_modules/@picoxr/pico-cli/package.json), executionTreeSha256: install.json contentManifestSha256}` (the recorded content-bound digest, revalidated by the existing execution guards before every spawn — controller resolution 1, first option). External = realpath, size + content sha256 folded into `executionTreeSha256`, plus the adjacent `@picoxr/pico-cli` package.json sha256 (sha256 of the empty string when none is found).
- `discoverCliCapabilities`: at most one `<route> --help` per operation (8 probes max), each under `updateCheckTimeoutMs` (default 120 s), a 64 KiB output cap, `killGraceMs`, and — for managed targets — the same `validateManagedPicoCliExecution` guard the wrappers use before and after spawn. Raw stdout/stderr and `report.json` are written once (`wx`, fsync) into `<managedRoot>/capabilities/<version>/<identityKey>/<runId>/`, outside the content-bound version root. Persistence failure never affects activation. External targets recompute their identity after discovery; drift discards the run.
- `attachCliCapabilities`: `"read-only"` (used by `inspectManagedPicoCli`, i.e. `preflight_env` / default `pico_doctor`) only reuses the newest persisted report whose entire identity matches and whose evidence verifies — no spawn, no write. `"discover"` (used by the exported `resolveManagedPicoCli`, i.e. the first real CLI-backed operation and `ensure_pico_cli`) reuses a verified report, or discovers when none exists or `forceRefresh` is set. Partial reports are persisted and reused; the force-refresh path re-discovers.
- The ok branch of `PicoCliEnsureResult` gains `capabilities?: CliCapabilityReport` (set + `coverage` + `limits` + `reportPath`); `ManagedPicoCliIO.run` gains `maxOutputBytes`.

### 3. `src/picocli.ts`
- `picoCliFromEnsure` binds the report to the target; new `picoCliOperationCapability(target, operation)` re-derives the target identity (managed: from the opaque handle; external: re-hash) and resolves through `resolveOperationCapability`.
- `classifyPicoCliFailure` gains `"environment"` (PICO_HOME unset / not absolute) and recognizes the 0.5.0 router text `Unknown perf subcommand` / `Unknown perf <resource> action` as `flag-or-version-drift`; `describePicoCliEnvironmentFailure` returns the exact PICO_HOME guidance and never prescribes running setup (checked by test against `/pico-cli\s+setup/`).

### 4. `src/preflight.ts` — emulator-status consumer only (plus the `PreflightIO` seam)
- `PreflightExecResult` adds optional `code`, `timedOut`, `spawnError`; `defaultBoundedIO` supplies them from the bounded runner.
- `emulatorStatusCheck`: pass requires no spawn error/timeout, a valid envelope with `tool_name: "emulator.status"`, `tool_status: SUCCESS` and exit consistent with the serializer mapping SUCCESS 0 / FAILED 3 / PARTIAL 4 (source-inspected `CLI_RESULT_SCHEMA`). Managed-integrity rejections (guard failures) are a distinct warning pointing at `ensure_pico_cli`; wrong/missing tool_name, SUCCESS/nonzero, malformed, timeout and spawn error are warnings that say what was inconsistent. PARTIAL keeps its "degraded" warning and the envelope's own remediation (deterministic precedence preserved). All independent gates are untouched.

### 5. `scripts/compare-picocli-surfaces.mjs` + `.github/workflows/picocli-compat.yml`
- `--retain <absolute new dir>`: each CLI invocation (version probes included) is written as `NNN.json/.stdout.txt/.stderr.txt` as it happens; `index.json` (limits, completion `complete|failed`, failure message, invocations with argv/status/hashes/byte counts) is written in `finally` on success and failure.
- A nonzero help answer with no advertised commands becomes an `inaccessibleSubtrees` entry (command, exitCode, reason via `classifyHelpFailureText`, stream hashes) and `coverage.state = "partial"`; the report adds `coverage {state, from, to}` and `retainedIndex` additively (the existing `from/to/added/removed/changedHelp/unchanged/safety` shape is unchanged).
- `assertSafeCliArgv`, `advertisedCommands`, `parseArguments` are exported; `main()` runs only when executed directly. Setup-subtree exclusion, `update --check` exclusion, detached-child ownership, depth 8 / 256 calls / timeout / output cap are unchanged.
- Workflow: `--from 0.4.4` (comment documents it as the last managed version the MCP was validated against), `--to latest` resolved at run time, `--retain`, raw retention uploaded `if: always()`, report uploaded on success, summary shows coverage and inaccessible subtrees and states the observation is neither semantic certification nor a publish request. 0.5.0 is not hardcoded anywhere.

### 6. `scripts/probe-windows-emulator.mjs` + `.github/workflows/windows-emulator-probe.yml`
- `resolve --identity-out <new file>`: `ensurePicoCli({forceRefresh:true})` through `dist/picocli.js`; accepts only a managed `ok` result; writes `{version, executablePath, executableSha256, capabilities.identity, …}` with `wx`.
- `probe --cli <abs> --identity <file>`: rejects relative paths, a `--cli` that differs from the recorded executable, or an invalid identity; hashes the supplied path and refuses to run anything on mismatch (`skipped: "integrity-mismatch"`); runs `-v` and stops dependent observations when the reported version differs (`skipped: "version-mismatch"`, exit 1); never calls npm and has no ambient fallback (`resolveCli` removed). Report schema 2 records `npm: {calls: 0, globalInstall: false}` and `cli: {targeting, requested, integrity, versionCheck, skipped}`.
- Workflow: resolve step (pwsh) writes the identity to a run-scoped path in `runner.temp`, passes the path through step outputs, probe writes a run-scoped output with `wx`, both records uploaded `if: always()`. Not executed on this host.

### 7. Fixtures and test infrastructure
- `test/fixtures/picocli/help/{0.4.4,0.5.0}/NNN.*` + `index.json` (provenance, hashes, the six nonzero invocations named). Copied with a one-off Python script that asserted byte equality and sha256 equality against `RAW_HELP_INDEX_002.json`; `test/picocli.mjs` re-verifies every fixture against both indexes on each run.
- `test/helpers/picocli-managed-fixture.mjs`: `FAKE_PICO_HELP_MAP` replay (retained bytes / exit codes / `hang`) in both fake drivers, `tool_name: "emulator.status"` in the fake envelope, exported `writeCommand`, `extraFiles` for `publishManagedFixtureVersion`, convergence-worker barrier moved from "9th canary" to the staged `-v` probe.

## TDD evidence

RED (tests written first, run against the unchanged build; outputs were saved under the session scratchpad `red/`):
```
$ node test/picocli.mjs                      → exit 1
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/dist/clicapabilities.js'
$ node test/preflight.mjs                    → exit 1  … Preflight test done. Failures: 7
  FAIL emulator-status consumer (SUCCESS with exit 3 is inconsistent): {"row":{…"status":"pass"…
  FAIL emulator-status consumer (wrong tool envelope): {"row":{…"status":"pass"…
  FAIL emulator-status consumer (missing tool_name): {"row":{…"status":"pass"…
  FAIL emulator-status consumer (timeout|spawn error|managed integrity rejection): … "pico-cli did not return JSON."
$ node --test test/picocli-autoinstall.mjs   → exit 1  (ERR_MODULE_NOT_FOUND dist/clicapabilities.js at import)
$ node --test test/picocli-sweep.mjs         → exit 1
SyntaxError: The requested module '../scripts/compare-picocli-surfaces.mjs' does not provide an export named 'assertSafeCliArgv'
$ node --test test/windows-emulator-probe.mjs → exit 1
SyntaxError: The requested module '../scripts/probe-windows-emulator.mjs' does not provide an export named 'parseProbeArguments'
```

GREEN (after `npm run build`, final runs on the committed tree):
```
$ npm run build                              → tsc clean
$ npm run test:picocli                       → exit 0   pico-cli lane test done. Failures: 0 ; tests 156 pass 156 fail 0
$ npm run test:preflight                     → exit 0   58 ok, Preflight test done. Failures: 0
$ node --test test/windows-emulator-probe.mjs → exit 0  tests 7 pass 7 fail 0
$ node --test --test-name-pattern='installed tarball keeps default startup|installed tarball wrapper lazily|setup-required wrapper results|public schemas and missing-vault results|preflight prints the verified' test/distribution-adoption.mjs
                                             → exit 0   tests 5 pass 5 fail 0
```
Intermediate red→green iterations worth knowing: (a) the convergence worker barrier counted the old nine canaries → moved to the staged `-v`; (b) my first timed-out-probe test used `updateCheckTimeoutMs: 1`, which also starved the registry lookup → replaced with a hanging help reply; (c) the sweep timeout-retention subtest flaked under CPU contention when run with the autoinstall file (the `-v` probe was killed at 50 ms) → uses the 1.5 s budget of the existing detached-descendant case and locates the timed-out record explicitly; (d) one probe-test assertion wrongly treated the token `install` in `emulator install … --help` as an install call → tightened to npm/`-g`/`--global`.

Additional suites run because they exercise the managed lane (all green): `npm run test:doors`, `npm run test:knowledge-lifecycle` (19/19), `npm run test:vault`, `npm run test:vaultdiff`, `npm run test:adoption-safety`, `node --test test/prompts.mjs`, `npm run test:tarball` (verify-tarball, new `dist/clicapabilities.js` accepted). `npm run test:distribution-adoption` as a whole is 41/43: the two failures are the pre-existing meta-gate cases (gate-lane count `linux: 45 !== 44` and the `test:` script inventory) that `AGENTS.md` documents as already red; their inputs (`gates.yml`, `package.json`, the test file) are byte-identical to HEAD.

Default doctor / registration zero-call confirmation: `installed tarball keeps default startup, tools/list, and pico_doctor read-only` (no npm, no managed-cli, no managed root, home unchanged) passes; `preflight_env` cached-store case now also asserts zero `--help` probes, zero `setup`, and no `capabilities/` directory; the new autoinstall case `read-only inspection never discovers…` asserts `inspectManagedPicoCli` runs only `-v` and creates no `capabilities/` directory, while a managed-cached `resolveManagedPicoCli` discovers without any npm call.

## Brief checklist

- [x] Fixtures for root help, knowledge server, watch timeout (096 `--monitor-timeout`), capture duration (097 clamp), profiler unavailable (012, 137–141), project-context change (067 vs 147/157); original bytes + source version/hash; historical fixtures untouched.
- [x] Sweep regressions retain argv/status/raw streams/limits/completion on success and failure; error-only child → partial subtree coverage; the six nonzero results drive the real failure cases (012 and 137–141 replayed through real child processes; retained hashes equal the evidence hashes).
- [x] Central guard regression cases (setup subtree, `update --check`, non-help argv); setup/mutating-update exclusions, detached-child ownership, depth/call/time/output limits retained; audit comparator used only as a diagnostic example.
- [x] Classification tests: matching help, generic parent help (root and perf parent), missing utilities, malformed, timeout, unsupported aliases; `Unknown perf subcommand` → drift; `PICO_HOME is not set` → `environment` with exact guidance that does not prescribe setup.
- [x] Stale tests: version change, same-version byte replacement, external replacement, missing evidence bytes → unknown / fresh discovery; old capabilities never applied to a new target.
- [x] Emulator-status consumer: `tool_name` required, exit/envelope consistency, SUCCESS/nonzero, wrong-tool, PARTIAL/4, FAILED/3, malformed, timeout, spawn-error, integrity-rejection fixtures; PARTIAL warning and independent gates preserved; only the consumer region and the IO seam touched in `preflight.ts`.
- [x] Windows probe: no global install, explicit validated absolute path, requested/reported identity recorded, integrity/version short-circuit, zero-npm fixture, workflow supplies the path via the managed boundary with fresh output paths; not run on this host.
- [x] Immutable reports with `complete|partial`, raw paths, run-unique directories, never overwritten; old consumers preserved (additive `capabilities`, legacy `compatibility` reader); startup/default doctor offline and non-provisioning.
- [x] Scheduled comparison: documented 0.4.4 baseline, freshly resolved latest, exact versions and failures retained as CI artifacts; no eternal 0.5.0; observation ≠ certification/publish.
- [x] Build + `test:picocli`, `test:preflight`, Windows probe suite, distribution-policy fixtures; commits contain only this deliverable.

## New test files needing CI registration
None. All coverage lives in the existing suites (`test/picocli.mjs`, `test/picocli-autoinstall.mjs`, `test/picocli-sweep.mjs`, `test/preflight.mjs`, `test/windows-emulator-probe.mjs`), all already wired through `test:picocli`, `test:preflight`, `test:picocli-win` and the Windows probe workflow. No `package.json` script was added.

## Evidence labeling
- **Help-observed (retained bytes):** every route's `supported` classification and the six nonzero gates come from `raw-help-002` invocations replayed byte-for-byte.
- **Source-inspected (byte-checked excerpts):** the 0.5.0 router allow-list and utilities gate ordering (PERF_ROUTER050/PERF_ENV050), the 0.4.4 forward-before-check behaviour (PERF_ENV044), the `tool_name`/exit mapping (EMULATOR_STATUS_RESULT/CLI_RESULT_SCHEMA), the 0.5.0 usage-error text templates.
- **Source-derived strings (constructed from templates, not observed):** the `Unknown perf subcommand: monitor …` and `[warn] PICO_HOME is not set …` texts used in tests are labeled as such in the test comments.
- **Fixture-tested stand-ins:** on 0.4.4 the per-operation `perf trace <op> --help` probes replay invocation 012 (`perf --help`), and on 0.5.0 the per-operation `perf live run` / `perf trace <op>` probes replay 139/141 — justified by the source-inspected gate ordering, and stated in the test comments.
- **Not established:** the help text of a *provisioned* profiler (never observable in the audit environment), so the `supported` phrase rule for `perf live run` / `perf trace <op>` has no positive retained example; real runtime/visual behavior on any host; Windows runner behavior (probe not executed here).

## Self-review findings
- Completeness: every brief checkbox is covered (above). Discipline: no new package scripts, no docs touched, no restructuring of `picoclimanaged.ts` beyond the wrapper split (`activateManagedPicoCli` + exported `resolveManagedPicoCli`) and the appended capability section. Testing: all tests use fake processes and retained bytes; nothing spawns a real `pico-cli`, `npm` or `setup` (the only real `ensurePicoCli` call site is the probe's `resolve` main path, which tests replace via injected `ensure`). Help hashes alone never yield `supported` (verified by the `evidence-missing`, `evidence-mismatch` and `report-inconsistent` cases).
- Removed an unused `platform` parameter from `externalCliCapabilityIdentity` during review.
- `src/picoclimanaged.ts` grew from 1741 to 2034 lines (all additions are in one clearly delimited trailing section plus the wrapper split); worth a follow-up extraction of the capability store into its own module once the C2–C4 tracks have merged, to avoid a three-way conflict now.

## Issues, concerns and notes for the controller
1. **Consumers (C2/C3/C4) still dispatch unconditionally.** `picoCliOperationCapability` is available but `knowledge.ts`, `picoclitools.ts`, `perfcli.ts`, `perftrace.ts` do not call it yet (out of C1 scope). The `environment` failure class and `describePicoCliEnvironmentFailure` are exported for them; wrappers currently render `environment` failures with their generic runtime note text (the `failureClass` field is correct).
2. **Partial reports are reused** until `ensure_pico_cli` (force refresh) runs; `unknown` reasons say so. If a first-use timeout should instead trigger automatic re-discovery on the next use, that is a one-line policy change in `attachCliCapabilities`.
3. **Capability run directories are never pruned** (immutable by design; a few KB per run). `ensure_pico_cli` creates one per call.
4. **Discovery adds up to 8 short help spawns** to the first real CLI-backed operation (and to every `ensure_pico_cli`); `distribution-adoption` and `knowledge-lifecycle` timings were unaffected in the runs above.
5. **Shared helper edited:** `test/helpers/picocli-managed-fixture.mjs` gained additive features (help-map replay, `tool_name` in the fake envelope, `writeCommand` export, `extraFiles`, barrier change). Parallel tracks editing the same helper will need a small merge.
6. **Report tampering scope:** a report's stored state is cross-checked against retained bytes, and evidence bytes are hash-bound; a rewritten `exitCode` inside `report.json` for a non-gate observation is not independently detectable (the managed store is MCP-owned and the package itself stays content-bound and guarded).
7. **Pre-existing red:** the two `distribution-adoption` meta-gate cases (gate-lane and script counts) remain red exactly as on `main`; the release track owns that inventory.
8. The evidence-fixture integrity check in `test/picocli.mjs` reads `evidence/…/RAW_HELP_INDEX_002.json` from the checkout (tracked in git), so it also runs in CI.

## Fix round 1 — unproven perf help classifications stay unknown

Reviewer finding: `src/clicapabilities.ts` treated an exit-0 help that failed the phrase rule as a terminal `unavailable` for every route, although the five perf routes have no retained exit-0 example (012 and 137–141 all exited at the utilities gate), so on a correctly provisioned machine a usable operation could be recorded as `unavailable` with `coverage: complete`.

### What changed (commit `c977ef0` — fix: leave unproven perf help classifications unknown)
- `CliOperationRoute` / both route tables gain `exitZeroHelpObserved`, with a comment citing the fixture index entry that holds the route's exit-0 help (0.4.4 062/025/026, 0.5.0 136/096/097) or noting its absence (0.4.4 012; 0.5.0 137–141). No operation name is hardcoded in the rule.
- The exit-0 branch of `classifyHelpOutput` now reads the help's `pico-cli …` usage/invocation lines (`usageRouteMatch`): a usage line starting with the route's full argv → `supported`; the proven parent shape `pico-cli <proper prefix of the route> <placeholder starting [ or <>` (retained 002, 011, 072, 080, 082 all have it) → `unavailable/generic-parent-help`; any other exit-0 shape → `unavailable` only when `exitZeroHelpObserved` is true, otherwise `unknown` with the same `generic-parent-help:` reason prefix plus "no retained exit-0 help validates this route's usage shape, so it stays unknown". The option defaults to the conservative branch.
- `classifyOperation` passes the route flag; `verifyOperationCapability` takes the set's version and re-classifies stored records under the same per-route flag (a stored terminal answer for an unproven shape is now `report-inconsistent`); `verifyCapabilitySet` / `resolveOperationCapability` pass `set.identity.version`. `capabilityCoverage` already reports `partial` for any `unknown`; a test now pins that for this case.
- Second defect surfaced while writing the tests: the previous whole-text phrase regex accepted the real 0.5.0 `knowledge --help` parent (fixture 080) as `supported` because its `doctor` row says "Check knowledge server configurations". The usage-line rule fixes it; 080 (and 011, 002) are now covered as parent-help cases with real bytes.

### Covering tests (test/picocli.mjs, "Fix round 1" block)
Real parent bytes 011/080/002/082 → `unavailable/generic-parent-help` (082 checked for trace-record and trace-query); synthetic provisioned-profiler help (source-derived shape, labeled as never observed) naming `pico-cli perf trace record` → `supported`; the same without the phrase (`pspp-profiler-cli trace record`), a re-rendered `pico-cli perf record`, and a `profiler live run` usage → `unknown` with `generic-parent-help:` (default and explicit flag); validated route + foreign child usage (`pico-cli knowledge doctor`) → `unavailable`; route tables carry the flag exactly for knowledge-server/watch-crash/capture-record on both lines; `classifyOperation` + `capabilityCoverage` → `partial` for the unknown case and `complete` for the proven parent case; `resolveOperationCapability` rejects a stored `unavailable` whose bytes now classify `unknown` (`report-inconsistent:`).

### Commands and output
RED (tests appended, run against the previous build):
```
$ node test/picocli.mjs → exit 1 … pico-cli lane test done. Failures: 9
  FAIL 0.5.0 knowledge parent help for knowledge server: expected unavailable … got {"state":"supported",…   (the 080 false positive)
  FAIL synthetic profiler help without the phrase stays unknown …: got {"state":"unavailable",…
  FAIL the unproven branch is the conservative default … / synthetic re-rendered help … / synthetic live help … : got unavailable
  FAIL exitZeroHelpObserved wrong: {}
  FAIL unproven exit-0 handling wrong … / proven parent-help handling wrong … / a stored terminal answer … rejected on re-verification …
```
GREEN (after `npm run build`, tsc clean):
```
$ node test/picocli.mjs        → exit 0   pico-cli lane test done. Failures: 0
$ npm run test:picocli         → exit 0   lane script Failures: 0; tests 156 pass 156 fail 0
$ npm run test:preflight       → exit 0   Preflight test done. Failures: 0   (no shared helper changed; run for completeness)
```
Ledgered Minor items were not touched in this round.
