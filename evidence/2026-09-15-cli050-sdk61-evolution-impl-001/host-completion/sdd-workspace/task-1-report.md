# Task 1 report — Fixture isolation: pinned adb in every fixture gate, explicit harness override, every door through its seam

Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-sdk61-evolution-2026-09-15` (branch `cli050-sdk61-evolution-2026-09-15`).
Base: `e1481ea`. Status: **DONE_WITH_CONCERNS** (all required gates green on this host; concerns are scope notes, listed below).

## Commits (in order)

| SHA | Subject |
|---|---|
| `641ec84` | fix: pin PICO_ADB in every fixture gate regardless of inherited value; explicit harness override only |
| `0af0055` | fix: a blank PICO_ADB is an explicit override and fails closed |
| `313c03a` | fix: every door reaches the inner server only through its dependency seam |

Every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Nothing pushed, no history rewritten, no stash used, `main` untouched. Version stays 38.0.0.

## What was implemented

### 1. `scripts/gate-inventory.mjs` — `gateChildEnv(gate, env, io = { isExecutableFile })`
- `fixture` and `installed-artifact` gates ALWAYS get a fresh env object with `PICO_ADB = FIXTURE_NO_ADB` (`/fixture/no/such/adb`). An inherited value — real path, empty string, whitespace — is replaced, never passed through. The caller's env object is never written.
- New export `HARNESS_ADB_VARIABLE = "PICO_GATE_FIXTURE_ADB"`: the one pass-through. When set, it must be an absolute path to an existing executable *file* (`fs.accessSync(X_OK)` + `statSync().isFile()`); the child then gets `PICO_ADB = <fake>` and keeps `PICO_GATE_FIXTURE_ADB` visible. Anything else (relative, nonexistent, a directory, blank) throws `Error` with `code: "GATE_FIXTURE_ADB_INVALID"`.
- `native-contract` gates get the identical `env` object back, no pin (unchanged).
- Doc comment rewritten to state the new rule and why the previous "caller-set value wins" rule was a hole.

### 2. `scripts/run-gate.mjs`
- `runGate` wraps `gateChildEnv`: a `GATE_FIXTURE_ADB_INVALID` error prints the message plus `[run-gate] fix: unset PICO_GATE_FIXTURE_ADB or point it at an executable fake` on stderr and resolves **exit 2 before any spawn**. Other errors still propagate. Header and inline comments updated.
- Verified live: `PICO_GATE_FIXTURE_ADB=/no/such/fake-adb node scripts/run-gate.mjs test:ledger` → exit 2, nothing spawned (in `step4-green-gate-inventory.log`).

### 3. `.github/workflows/gates.yml` — comment only
- The workflow-level `env: PICO_ADB: /fixture/no/such/adb` block is byte-identical (the gate-inventory test pins it). The comment now says run-gate REPLACES any inherited value for gate children, so the workflow value is belt-and-braces there and the barrier only for the one raw `node --test test/homeenvironmenthost.mjs` step.

### 4. `src/adb.ts` — `pick()`
- `const raw = io.env.PICO_ADB; if (raw !== undefined) { const declared = raw.trim(); if (declared === "") return { kind: "override-rejected", rejection: { path: "", reason: "is set but empty — unset PICO_ADB to use the PATH/bundled chain, or name an absolute executable" } }; … }` — the same fail-closed path a nonexistent file takes; nothing is probed (`probed` stays `[]`).
- `refuseOverride` formats an empty path as `""`, so `adbExecutable` throws `$PICO_ADB="" is set but empty — …` (the message still names a set variable). Non-empty paths are formatted exactly as before, so every existing message/test is unchanged.
- Header comment gains the blank-value rule.

### 5. `src/doors.ts` — `registerDoorTools(server, dependencies?)`
- `injected = dependencies ? (dependencies.callRaw ? lanesOf(dependencies.callRaw, …) : { call: dependencies.call }) : null`. With any dependencies object (even `{}`) no door reaches `inner()`.
- `doorCall()` returns `injected.call` or throws `seamError("call")`; `doorCallRaw()` returns `injected.callRaw` or throws `seamError("callRaw")`; both fall back to the shared inner client only when `dependencies` is undefined (production).
- `seamError` text: `registerDoorTools was given a fixture (a dependencies object) without dependencies.<lane>: doors never spawn the real inner full-surface server on a fixture, so this call is refused. …` — the `callRaw` variant still names `pico_look`, `pico_verify_app`, `call-only` and `callRaw`, so the existing partial-injection test's regexes keep passing without being weakened.
- The nine direct `const { call } = await inner();` sites (pico_scan_world, pico_place, pico_measure, pico_perf, pico_sdk, pico_doctor, pico_capabilities, pico_fix, pico_next) became `const call = await doorCall();`. `pico_loop` already used `doorCall()`. Exactly three `await inner()` sites remain: `innerCall()` (used by `src/spatialbench.ts`), `doorCall`'s fallback, `doorCallRaw`'s fallback.

### 6. `AGENTS.md` — gotcha paragraph "One inventory owns every gate command…"
- The run-gate clause now states: inherited `PICO_ADB` values (real / empty / whitespace) are replaced; `PICO_GATE_FIXTURE_ADB` naming an absolute executable fake is the only pass-through and anything else refuses the gate (exit 2) before a child exists; `src/adb.ts` refuses a blank `PICO_ADB` too; `gates.yml` keeps its value only for the raw step. Outside the byte-pinned policy block; `test:distribution-adoption` (which scans the file for the forbidden vocabulary) passes 43/43. Paragraph re-wrapped to ≤100 columns.

### 7. Tests
- `test/gate-inventory.mjs`: the brief's six `gateChildEnv` cases verbatim (blank `""`/`"   "` added to the invalid-override list); the old "a caller-set PICO_ADB always wins" case rewritten as "an inherited PICO_ADB is replaced by the pin, whatever it holds" (real / `""` / `"   "` / `"\t"`, caller env untouched); two `runGate`-level cases (valid override reaches the child as `PICO_ADB` with the variable kept; invalid override → exit 2, fix printed on stderr, no spawn). Section comment updated.
- `test/toolchain-cache.mjs` (the adb resolution file — `grep -ln 'override-rejected'` matches nothing because the tests use `overrideRejected`; the file's helper is `adbIO`, the entry point `resolveAdbExecutable`): new case for `""`, `"  "`, `"\t"` → `status unavailable`, `code unavailable/adb-override-unusable`, `overrideRejected.path === ""`, reason `/set but empty/`, `probed` deep-equals `[]`, no PATH/bundled payload read, `adbExecutable` throws `/\$PICO_ADB="" is set but empty/`.
- `test/doors.mjs`: new block "every door through its seam". Registers `registerDoorTools(bare, {})`, lists the tools, asserts the bare server registers exactly the 16 doors the block drives, calls each with minimal schema-valid args under a 10 s `callTool` request timeout, requires `status:"error"` with `/dependencies\.call|dependencies\.callRaw/`, and asserts the source has exactly three `await inner()` sites. The block is hermetic against a regressed adapter: `PICO_ADB` → exit-1 stub, `HOME` → scratch dir, `PICO_MCP_CLI_POLICY` → `disabled` (all restored in `finally`), `pico_place` gets a real empty scene file (it reads the file before the seam), `pico_loop` gets an invalid `draftSpec` (plan-failed before any build on old code), `pico_record` uses a `vision_verified` claim without an artifact (rejected, never written, on old code).

## Tests run and results (final tree unless noted)

| Command | Result | Log |
|---|---|---|
| `npm run build` (after adb fix) | ok, source `ddfca596b714`, verifyBuild current | `build-after-adb-fix.log` |
| `npm run build` (after doors fix) | ok, source `ebed0d641fac`, verifyBuild current | `build-after-doors-fix.log` |
| `PICO_ADB=… node --test test/gate-inventory.mjs` | 46/46 pass | `step4-green-gate-inventory.log` |
| `PICO_ADB=… node --test test/toolchain-cache.mjs` | 33/33 pass | `step7-green-toolchain-cache.log` |
| `PICO_ADB=… npm run --silent test:sdkselection` | 176/176 pass, exit 0 | `step7-gate-test-sdkselection.log` |
| `node test/doors.mjs` (direct, shell pins as in RED) | Failures: 0; `every door refuses through the seam on a {} fixture (16/16)`; fake PATH adb invocations: 0 | `step11-green-doors.log` |
| `PICO_ADB=… npm run --silent test:doors` | doors Failures: 0 + innerclient 17/17, exit 0 | `gate-test-doors.log` |
| `PICO_ADB=… npm run --silent test:lint` | lint ok (55 invocations / 54 suites agree) + 57/57, exit 0 | `gate-lint.log` |
| `PICO_ADB=… npm run --silent test:distribution-adoption` | 43/43, exit 0 | `gate-distribution-adoption.log` |
| `PICO_ADB=… npm run --silent test:docsmeta` | 26/26, exit 0 | `gate-docsmeta.log` |

`test:lint`, `test:distribution-adoption` and `test:docsmeta` were run on the exact final tree (after the last AGENTS.md rewrap) immediately before commit 3. `test:doors` and `test:sdkselection` do not read AGENTS.md and their inputs (`dist/`, tests) were unchanged after their runs.

## TDD evidence

### Step 1–4 (gate-inventory)
- RED — `PICO_ADB=/fixture/no/such/adb node --test test/gate-inventory.mjs` (`step2-red-gate-inventory.log`):
  `SyntaxError: The requested module '../scripts/gate-inventory.mjs' does not provide an export named 'HARNESS_ADB_VARIABLE'` → `ℹ fail 1`, exit 1. Expected: the export did not exist yet. Supplementary one-liner against the unchanged `gateChildEnv` in the same log: `"/opt/homebrew/bin/adb" -> {"PICO_ADB":"/opt/homebrew/bin/adb"}`, `"" -> {"PICO_ADB":""}`, `"   " -> {"PICO_ADB":"   "}` — all three inherited values passed through.
- GREEN — same command (`step4-green-gate-inventory.log`): `ℹ tests 46 … ℹ pass 46 ℹ fail 0`, exit 0; live CLI: `PICO_GATE_FIXTURE_ADB="/no/such/fake-adb" must be an absolute path to an existing executable fake adb; refusing to spawn fixture gate children` / `fix: unset PICO_GATE_FIXTURE_ADB or point it at an executable fake` / `exit=2`.

### Step 5–7 (adb)
- RED — `PICO_ADB=/fixture/no/such/adb node --test test/toolchain-cache.mjs` against `dist/` built from the unchanged `src/adb.ts` (`step6-red-toolchain-cache.log`): `✖ a set-but-blank PICO_ADB is an explicit override that fails closed, probing nothing` with `actual: 'ok', expected: 'unavailable'` — 32 pass / 1 fail, exit 1. Expected: a blank value fell through to the PATH adb.
- GREEN — after the fix + `npm run build` (`step7-green-toolchain-cache.log`): `ℹ tests 33 … ℹ pass 33 ℹ fail 0`, exit 0; `test:sdkselection` 176/176.

### Step 8–11 (doors seam)
- RED — `node test/doors.mjs` with `dist/doors.js` built from the unchanged `src/doors.ts`, shell env `PICO_ADB=/fixture/no/such/adb PICO_MCP_CLI_POLICY=disabled PATH=<scratch fakebin with a logging exit-1 adb>:$PATH` (`step9-red-doors.log`): 14 `FAIL <door>: a door on a lane-less fixture must refuse through the seam, got …` lines (real inner-server answers, e.g. `pico_doctor … "adb","status":"fail","detail":"$PICO_ADB=/var/folders/…/pico-door-seam-…/adb …"`, `pico_perf … "failureClass":"cli-disabled"`), `FAIL only 2/16 doors refused through the seam on a {} fixture`, `FAIL doors.ts has 12 inner() sites; expected exactly three`, `Doors test done. Failures: 16`, exit 1; `fake PATH adb invocations during the run: 0`. Expected: the nine direct `inner()` doors (plus the five that already used `doorCall()` but had no injected `call` to return) reached the real inner server. The run touched no emulator/device/adb server/npm/managed store: the stub adb failed closed in the doctor's own output, CLI use was disabled, HOME was a scratch dir, and the PATH tripwire adb was never invoked.
- GREEN — same command after the fix + `npm run build` (`step11-green-doors.log`): `ok every door refuses through the seam on a {} fixture (16/16)`, `ok doors.ts has exactly three inner() sites (innerCall, doorCall, doorCallRaw)`, `Doors test done. Failures: 0`, exit 0, fake PATH adb invocations 0.

## Files changed
- `scripts/gate-inventory.mjs` (new imports `node:fs`/`node:path`, `HARNESS_ADB_VARIABLE`, `isExecutableFile`, rewritten `gateChildEnv` + comments)
- `scripts/run-gate.mjs` (refusal wrapper, import, comments)
- `.github/workflows/gates.yml` (comment only)
- `src/adb.ts` (`pick()`, `refuseOverride` empty-path formatting, header comment)
- `src/doors.ts` (`registerDoorTools` lane resolution + `seamError`; nine door sites → `doorCall()`)
- `AGENTS.md` (run-gate gotcha clause)
- `test/gate-inventory.mjs`, `test/toolchain-cache.mjs`, `test/doors.mjs`
- `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-1/*.log` (13 logs, force-added in `313c03a`)

## Self-review findings (fixed before reporting)
- The brief's "ten `inner()` sites" was nine: `pico_loop` (brief line 1016) already used `doorCall()`. My first edit script asserted 10, found 9 and aborted before writing anything; re-applied with 9. The RED count of 12 total (`9 + innerCall + doorCall + doorCallRaw`) confirms it.
- Brief inconsistency: the Interfaces section names `io = { existsSync: fs.existsSync, isExecutable }` while the Step 3 code uses `io = { isExecutableFile }`. Implemented the Step 3 code (the tests pass no `io`).
- `test/doors.mjs` has `ok`/`fail` helpers (no `expect`, no `listToolNames`/`callTool` helpers); the block uses the file's `McpServer` + `InMemoryTransport` + `Client` pattern and the SDK's `callTool(params, undefined, { timeout: 10_000 })` request bound.
- `registerDoorTools` registers 16 doors, not 18: `validate_toolchain` and `ensure_pico_cli` are registered by `src/index.ts` outside the seam and never call `inner()`. The block asserts the bare fixture registers exactly the 16 doors it drives, so a new door without minimal args fails loudly instead of being skipped.
- A blank `PICO_GATE_FIXTURE_ADB` is treated as an invalid override (refuse), not as unset — added to the invalid list.
- AGENTS.md paragraph re-wrapped twice to keep ≤100 columns and no orphan line; the three doc/inventory gates were re-run on the final text.
- `src/doors.ts` is large (1231 lines); worked within the existing structure, no restructuring.

## Issues / concerns for the controller
1. **Parallel blank-value gap outside the brief's file list**: `src/preflight.ts` `declaredAdbOverride()` still trims and treats a blank `PICO_ADB` as unset, so the doctor's adb row probes PATH (`adb version`) and, if one answers, the emulator row runs `adb devices` against it. Direct invocations with a blank export are the only exposure now (run-gate never hands a blank value to a gate child); flagged, not fixed (scope).
2. `src/nativefleetreceipt.ts:426` `adbPath: deps?.adbPath ?? process.env.PICO_ADB ?? "adb"` bypasses the shared adapter (a blank value becomes `""`, a real one is trusted by string). Outside scope; flagged.
3. Stale rule statements remain in `CHANGELOG.md:82-83` ("unless the caller set one") and `docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md:74,144,658-659` ("caller-set value always wins"). The brief scoped docs to AGENTS.md and the constraints preserve the checkpoint's records; Task 6's fresh checkpoint/CHANGELOG should carry the new rule.
4. The RED doors run intentionally let today's code spawn one real inner full-surface server child inside the test process (that is what the brief predicted and what proves the hole). It ran hermetically as described above; `pico_sdk` returned a real read-only vault answer despite the scratch HOME (the vault resolves from a non-HOME default), which is read-only and harmless.
5. The new `test/doors.mjs` block sets `process.env.PICO_MCP_CLI_POLICY = "disabled"` in test code for hermeticity; the vocabulary gate covers only the six markdown docs (`test:distribution-adoption` passes).
6. `pico_doctor {}` (MCP) was not called this session per the dispatch's "never touch MCP tools/pico_doctor"; the environment was not needed for this host-only task.

## Log paths (all under `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-sdk61-evolution-2026-09-15/evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-1/`)
- `step2-red-gate-inventory.log`, `step4-green-gate-inventory.log`
- `step6-red-toolchain-cache.log`, `build-after-adb-fix.log`, `step7-green-toolchain-cache.log`, `step7-gate-test-sdkselection.log`
- `step9-red-doors.log`, `build-after-doors-fix.log`, `step11-green-doors.log`
- `gate-test-doors.log`, `gate-lint.log`, `gate-distribution-adoption.log`, `gate-docsmeta.log`


---

## Fix report — coordinator fold (2026-09-16): the doctor and the native fleet receipt apply the adapter's blank-PICO_ADB rule

Commit: `33ec6b8` fix: the doctor and the native fleet receipt apply the adapter's blank-PICO_ADB rule (trailer present; tree clean; nothing pushed).

### What changed
- **`src/adb.ts`** — the blank rule lives once: new exports `AdbOverrideDeclaration`, `classifyAdbOverride(raw)` (`unset` | `blank` with the `AdbOverrideRejection` | `declared` with the trimmed path) and `describeAdbOverrideRejection(rejection)` (`$PICO_ADB=<path> <reason>`, an empty path printed as `""`). `pick()` and `refuseOverride` now use them; behaviour and every existing message are unchanged (toolchain-cache 33/33 inside `test:sdkselection`).
- **`src/preflight.ts`** — `declaredAdbOverride()` returns the adapter's classification instead of a trimmed string. `adbCandidates()` yields `[path]` for a declared override, **`[]` for a blank one** (nothing probed), and the PATH → selected → legacy chain only when unset. The adb row fails a blank override with `${describeAdbOverrideRejection(...)}; an explicitly configured adb is never replaced by a PATH or bundled candidate, so nothing else was probed` and a fix that starts with "Unset PICO_ADB"; the declared-but-unanswering row is unchanged. Because `findAdb()` finds nothing, the emulator row stays `unknown` ("cannot check without adb") and no `adb devices` runs.
- **`src/nativefleetreceipt.ts`** — new `resolveAdbPath(deps)`: `deps.adbPath` when injected (tests; fleetbuild already passes its adapter-resolved `ADB()`), otherwise `adbExecutable()` from `src/adb.ts`; the adapter's throw becomes `StageFailure("adb-resolution", …)`. `resolvedDeps` is now built inside the fail-closed `try`, so the refusal returns `{ status: "failed", stage: "adb-resolution", built: false, installed: false, reason: "[adb-resolution] $PICO_ADB=\"\" is set but empty … no fallback was attempted …", completedStages: [] }` before Gradle, adb or any capture command. `NativeFleetFailureStage` gains `"adb-resolution"` (first); a successful resolution is not recorded as a completed stage (the receipt's stage vocabulary is unchanged).
- **`src/runrevisiontypes.ts`** — `NativeFleetFailureStageV1` mirrors the new stage (type-only; no runtime validator enumerates these stages — verified by grep).

### Tests
- `test/preflight.mjs`: delimited block appended at the end of the file (existing blocks untouched, not reordered). For `""`, `"   "`, `"\t"` with a working PATH adb AND a working bundled adb present: adb row `fail`, detail matches `/\$PICO_ADB=""/`, `/is set but empty/`, `/nothing else was probed/`, fix matches `/unset/i`; zero `version` probes recorded; zero argv containing `devices`; emulator row `unknown` with "without adb".
- `test/nativefleetreceipt.mjs`: "producer resolves adb through the shared adapter: a blank or unusable PICO_ADB fails closed before Gradle, spawning nothing" — for `""`, `"   "` and `/fixture/no/such/adb` (the last proves a real value goes through the same identity check: `names no existing file`), with `adbPath` omitted from the injected deps: `status failed`, `stage adb-resolution`, `built/installed false`, reason matches the adapter's words and `/no fallback was attempted/i`, `completedStages []`, `fixture.events []` (no Gradle/adb/capture command), no receipt file. `process.env.PICO_ADB` is saved and restored via `t.after`.

### TDD evidence (logs under `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-1/`)
- RED `fold-red-preflight.log` — `PICO_ADB=/fixture/no/such/adb node test/preflight.mjs` against `dist/` built from the unchanged `src/preflight.ts`: 12 FAILs, e.g. `adb row mishandled a blank PICO_ADB (""): {"name":"adb","status":"pass","detail":"adb (from PATH)"}`, `still probed ["adb"]`, `adb devices ran behind a blank PICO_ADB (""): [["adb","devices"]]`, `emulator … "pass","detail":"emulator-5554 (device)"`; `Failures: 12`, exit 1. Expected: the row trimmed the blank to "" and walked PATH.
- RED `fold-red-nativefleetreceipt.log` — `node --test test/nativefleetreceipt.mjs` against the unchanged producer: the new test fails with `actual: 'receipt-publication', expected: 'adb-resolution'` (the blank value became the adb command and the run proceeded), 76 pass / 1 fail, exit 1.
- Build `fold-build.log` — `npm run build` ok, source `afc8c6907105`, verifyBuild current.
- GREEN `fold-green-preflight.log` — `Failures: 0` (12 new `ok` lines), exit 0.
- GREEN `fold-green-nativefleetreceipt.log` — 77/77, exit 0.
- Gates on the final tree: `fold-gate-preflight.log` (`Failures: 0`, exit 0), `fold-gate-runreceipt.log` (337/337, exit 0), `fold-gate-sdkselection.log` (176/176, exit 0).

### Self-review notes
- No second copy of the blank rule: preflight and `pick()` both call `classifyAdbOverride`; the message formatting for an empty path lives only in `describeAdbOverrideRejection`.
- The S4 preflight cases (declared override that answers / does not answer, PATH-first ordering, bundled fallback, no-override candidate listing) and the S6 consumer matrix are unchanged and green.
- Concerns 1 and 2 of the original report are now closed; concerns 3–5 stand (stale CHANGELOG/checkpoint rule sentences for Task 6; the RED doors run's one hermetic inner-server spawn; `PICO_MCP_CLI_POLICY=disabled` set in test code for hermeticity).
