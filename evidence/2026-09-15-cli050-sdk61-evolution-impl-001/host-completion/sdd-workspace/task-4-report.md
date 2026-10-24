# Task 4 report — Bounded, correlated log observation: no implicit global logcat clear anywhere

Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-sdk61-evolution-2026-09-15` (branch `cli050-sdk61-evolution-2026-09-15`).
Base: `070e4a8`. Status: **DONE_WITH_CONCERNS** (every required gate green on this host; concerns are scope/behaviour notes, listed below — none is a red gate).

## Commits (in order)

| SHA | Subject |
|---|---|
| `c5662f3` | feat: marker-correlated bounded log windows replace global logcat clearing |
| `80fb227` | fix: observation paths open marker windows instead of clearing the device log |

Both end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Nothing pushed, no history rewritten, no stash, `main` and the sibling worktrees untouched, none of the disjoint Task 2/3 files touched. Version stays 38.0.0. No emulator, device, adb server, MCP tool, `pico_doctor`, managed CLI store, registry, or the Mission Replay project was contacted — every test ran against a recording fixture adb with `PICO_ADB=/fixture/no/such/adb` exported in the shell.

## What was implemented

### `src/logwindow.ts` (new — the one owner of the marker/window logic)

Exactly the brief's interface plus two small additions the sites needed:

- `LOG_WINDOW_TAG = "pico-mcp"`, `DEFAULT_LOG_WINDOW_MAX_LINES = 4000`, `LogWindow { serial, marker, openedAt }`, `AdbRunner`.
- `newLogMarker()` → `pico-mcp-window-<uuid>`.
- `openLogWindow(run, serial)` → one `["-s", serial, "shell", "log", "-t", "pico-mcp", marker]` (10 s bound). Never clears. Throws **`LogWindowOpenError`** (addition: carries `serial` and the attempted `marker`, so a site can still report which window failed to open).
- `readLogWindow(run, window, { tags?, buffers?, maxLines?, timeoutMs? })` → `["-s", serial, "logcat", ...("-b", b)*, "-d", "-v", "threadtime", "-t", maxLines, ...(tags ? [tag:V…, "pico-mcp:V", "*:S"] : [])]`, sliced after the marker; returns `{ markerSeen, lines, raw }`. Throws when the dump command itself fails (so a failed dump is never mistaken for an evicted marker). A tagless read carries **no** filter: a `pico-mcp:V *:S` filter there would hide the lines being awaited.
- `sliceAfterMarker(stdout, marker)` → lines after the LAST line containing the marker; `{ markerSeen:false, lines:[] }` when absent; trailing empty lines dropped (`\r\n` tolerated).
- `logWindowFromMarker(serial, marker)` (addition) adopts a marker a caller wrote itself — what `assert_logcat`'s `sinceMarker` needs.

### Sites (each: window opened BEFORE the action, bounded read after, `serial` + `logWindow` reported, `markerSeen:false` inconclusive)

| Site | Change |
|---|---|
| `src/assertscene.ts` `runAssertScene` / `assert_scene` | Window before the `dump_scene` broadcast; `readLogWindow(..., { tags: [tag] })`; `parseDump(lines.join("\n"))`. Unseen marker → `{ error: "log window marker <m> was evicted before the dump was read on <dev>; the buffer was not cleared, re-run", serial, logWindow }`. Open failure → error, **nothing driven or read**. Every return (pass/fail/error) carries `serial` and `logWindow`. `markers` input description no longer claims a clear. `src/verify.ts` consumes the same `{error}` / `{pass}` shape unchanged. |
| `src/sense.ts` `probe_planes` | One window before the broadcast; every poll re-reads it with `tags: [t, "AgentBridge"]`; a poll without the marker parses nothing. Success adds `serial` + `logWindow` (keeps `device`). Never-seen marker → `fail(JSON {status:"inconclusive", serial, logWindow, error})`. |
| `src/copilot.ts` `snapshot` / `live_scene_snapshot` | `snapshot()` now returns `ok | no-dump | inconclusive` with `serial` and `logWindow`; only window lines are parsed; the tool forwards all three shapes. |
| `src/workflow.ts` `build_and_run` | Window opened before launch (open failure → `fail`). The **PID-scoped** read stays PID-scoped (see Decisions); the **global** crash-correlation read is the window's lines. `report.steps.push({ logWindow: { marker, markerSeen }, serial })`. Unseen marker → `fail(...)` carrying the report so far and any PID-scoped crash lines. `outputSchema` + `structuredContent` gain `serial` and `logWindow: { marker, markerSeen: literal(true) }`. |
| `src/doors.ts` `pico_loop` | `logMarker = newLogMarker(); call("adb_shell", { command: "log -t pico-mcp <marker>" })` before the build when any logcat criterion exists; `sinceMarker` passed to every `assert_logcat`; `status:"inconclusive"` / `logWindow.markerSeen === false` → `unmeasurable` (never a fail that replans); `iterationsLog[i].logWindow = { marker }`. Door description and the three stale "assert_scene clears logcat" comments corrected. Task 1 minor folded: `dependencies !== undefined`. |
| `src/adb.ts` `assert_logcat` | New `sinceMarker`; `clearFirst` kept and re-described (opens a window; equivalent to a fresh `sinceMarker`); with a window the poll matches only `sliceAfterMarker` lines; without one the whole buffer stays the (compatible) scope; results carry `serial` and `logWindow` (`null` when no window). Never-seen marker → `{ matched:false, status:"inconclusive", serial, logWindow:{marker, markerSeen:false}, hint }` (non-error, as `matched:false` always was). Tool description rewritten ("Nothing here clears the device log"). |
| `src/agentloop.ts` `wait_for_log` | Default `clearFirst:true` opens a window; matched → `okJson({ matched:true, elapsedSec, serial, logWindow, lines })` (was free text); timeout stays `fail` (now names serial and marker); never-seen marker → `fail("Inconclusive: … status=inconclusive")`. |
| `src/boundaryexperiment.ts` prepare step | New exported `collectPreparationLogWindow(runner, serial, artifactPath)`: opens the window, reads `-b all` bounded, writes the sidecar **`prepare-log-window.txt`** (`# window marker <m> seen=<bool>` then the lines, via the module's `privateWriteBytes`/`assertExternalCapturePath`), throws new exported `LogWindowEvictedError` when unseen. The prepare step calls it in place of `logcat -b all -c`, before `startOwnedLogWindow`; the catch maps `LogWindowEvictedError` → `BoundaryPreparationFailure{ structuralStop: "log_window_evicted" }` (added to the union), anything else → `preparation_failed`. |
| `src/adb.ts` `logcat` `clear:true` | The ONE destructive clear (`src/adb.ts:382`). Requires an explicit `serial` — checked **before** `resolveSerial`, so a refused clear runs no adb command at all; blank/whitespace is refused too. Description: "DESTRUCTIVE: erases the device's global log buffer … explicit serial required (no sole-device resolution)". |

### Tests

- `test/logwindow.mjs` (new, 19 cases): the brief's four unit tests; a **recording fixture adb** (argv JSONL; marker writes recorded and echoed back inside dumps; broadcasts answered; untargeted commands refused; any `logcat … -c` exits 97 and writes a violations record); real tool registration over `McpServer` + `InMemoryTransport` so zod defaults apply; per-site cases for assert_scene (fresh dump matches, stale pre-marker entity does not, eviction → error, open-failure → no dump/no broadcast), probe_planes (fresh inventory / eviction), live_scene_snapshot (fresh / eviction), assert_logcat (adopted `sinceMarker` hit + pre-marker miss + tagged filter; `clearFirst` opens; eviction inconclusive; no-window compatible scope), the `logcat` tool (description text, refusal without serial runs nothing, blank refused, explicit serial → exactly `["-s", FIX, "logcat", "-c"]`), wait_for_log (default window, stale miss, eviction inconclusive, `clearFirst:false` unscoped), pico_loop through the `{ call }` seam (one `adb_shell` marker write before `fleet_build`, `sinceMarker` on every `assert_logcat`, marker in `iterationsLog`, inconclusive → `unmeasurable-acceptance` with no `replan_spec`), the boundary prepare helper (open → `-b all -d -t` read, sidecar content, eviction throws with `seen=false` recorded), and the **source-level guard** pinning `["adb.ts:382"]` plus a check that line 382 is still the explicit clear. Every site case asserts no argv contains `logcat` followed by `-c` and that the tripwire never fired.
- `test/helpers/buildrun-smoke-fixture.mjs`: the smoke fixture adb gains the same clear tripwire (`fixture-adb-cleared-log`, exit 97), accepts `shell log -t pico-mcp <m>`, and echoes only the markers it was actually asked to write in the global dump (an unopened window reads as evicted). `test/smoke.mjs` gains the check "no global log clear".
- `test/boundaryexperiment.mjs`: the source pin flips from "exactly one `-b all -c`" to **zero** destructive resets, adds "no `"logcat", "-c"`", requires `await collectPreparationLogWindow(` before the prepare collector, and pins the `log_window_evicted` mapping.
- `test/doors.mjs`: comment fixes only ("Nine doors"; the ordering comment no longer claims assert_scene clears).
- `scripts/gate-inventory.mjs`: `test/logwindow.mjs` added to `test:observation`'s command list (counts derive; `test:lint` / `test:distribution-adoption` green).

## TDD evidence (logs under `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-4/`)

| Step | Log | Result |
|---|---|---|
| 2 RED — `node --test test/logwindow.mjs` before `src/logwindow.ts` | `step2-red-logwindow.log` | `ERR_MODULE_NOT_FOUND dist/logwindow.js`, exit 1 |
| 3 GREEN — build + 4 unit tests | `step3-green-logwindow.log` | 4/4 pass |
| 4 RED — 14 site fixtures against the unchanged sites | `step4-red-sites.log` | 4 pass / 14 fail (tripwire fired, no `serial`/`logWindow`) |
| 4 build after site edits | `step4-build.log` | tsc clean, 191 files |
| 4 GREEN — site fixtures | `step4-green-sites.log` | 18/18 pass |
| 5 GREEN — with the source guard | `step5-green-logwindow-guard.log` | 19/19 pass |
| final — rebuild + logwindow + doors after the `iterationsLog.logWindow` addition | `final-build-logwindow-doors.log` | 19/19; doors `Failures: 0`, innerclient 17/17 |

## Gates (all green on this host, `PICO_ADB=/fixture/no/such/adb`)

| Gate | Log | Result |
|---|---|---|
| `test:observation` (final) | `final-gate-test-observation.log` (earlier: `gate-test-observation.log`) | 67/67 |
| `test:doors` | `gate-test-doors.log` | doors `Failures: 0`; innerclient 17/17 |
| `test:emulator-restart` | `gate-test-emulator-restart.log` | pass (1 skipped, pre-existing) |
| `test:conformance` | `gate-test-conformance.log` | pass |
| `test:preflight` | `gate-test-preflight.log` | `Failures: 0` |
| `test:picocli` | `gate-test-picocli.log` | pass |
| `test:lint` (final) | `final-gate-test-lint.log` (earlier: `gate-test-lint.log`) | 57/57 + lint fixture `Failures: 0` |
| `test:docsmeta` | `gate-test-docsmeta.log` | pass |
| `test:distribution-adoption` | `gate-test-distribution-adoption.log` | pass |
| `smoke` | `gate-smoke.log` | 11/11 checks incl. `build_and_run structuredContent success path` and `no global log clear` |
| extra: `test:copilot`, `test:placeonsurface`, `test:sdkselection` (176/176), `test:adoption-safety`, `test:vault`, `test:smoke-isolation` (3/3) | `gate-extra-test-*.log` | all exit 0 |

(The `exit=` lines inside `final-build-logwindow-doors.log` print empty — a zsh `PIPESTATUS` artifact; the pass/fail counts and `Failures: 0` lines in that log are the evidence.)

## Files changed

`src/logwindow.ts` (new), `src/adb.ts`, `src/agentloop.ts`, `src/assertscene.ts`, `src/boundaryexperiment.ts`, `src/copilot.ts`, `src/doors.ts`, `src/sense.ts`, `src/workflow.ts`, `scripts/gate-inventory.mjs`, `test/logwindow.mjs` (new), `test/boundaryexperiment.mjs`, `test/doors.mjs`, `test/helpers/buildrun-smoke-fixture.mjs`, `test/smoke.mjs`, plus the evidence logs above (force-added). No `docs/` edits; the incident records are untouched.

## Decisions the brief could not know (deviations, with reasons)

1. **Boundary prepare sidecar is `prepare-log-window.txt`, not `prepare-logcat-all.txt`.** The brief names the latter, but that path is the *streaming* `collectLogWindow` child's own artifact (`startOwnedLogWindow`, which `test/boundaryexperiment.mjs` requires to remain in prepare), and `collectLogWindow` refuses an existing artifact path. The window read therefore lands in a sibling file with the brief's exact header line; the streaming collector starts after the window opens and is correlated to the marker instead of to an erased buffer.
2. **`build_and_run`'s PID-scoped read is not routed through the window.** A `--pid` dump can never contain the marker (the marker is written by the shell `log` process), so forcing it through `readLogWindow` would make every run inconclusive. The PID is post-window by construction (observed after launch), so that read is already bounded to this launch; only the global correlation read goes through the window.
3. **`openLogWindow` throws (`LogWindowOpenError`) rather than returning a status**, so an unopened window can never be read from; sites catch it and report `serial` + `logWindow: { marker, markerSeen:false }` and drive/read nothing.
4. **Polling sites treat a not-yet-seen marker as "keep polling" and report inconclusive only at their deadline** (`assert_logcat`, `wait_for_log`, `probe_planes`, `snapshot`), so a marker that lands a beat after the first poll is not misread as evicted; `assert_scene` (single read after its settle) reports immediately.
5. **`wait_for_log`'s matched result is now JSON** (`{matched, elapsedSec, serial, logWindow, lines}`) instead of free text, to carry the required fields machine-readably; no test pinned the old text. Its timeout/inconclusive outcomes stay `isError`.

## Self-review

- **Completeness:** the guard test enumerates `src/*.ts` and finds exactly `adb.ts:382`; a `grep` over `dist/` shows the same single site. Every replaced site reports `serial` and `logWindow` (pico_loop via `iterationsLog[i].logWindow` and the inner tools' own results). `markerSeen:false` is inconclusive at all nine sites (assert_scene error, probe_planes isError JSON, snapshot `inconclusive`, build_and_run isError, pico_loop `unmeasurable`, assert_logcat `status:"inconclusive"`, wait_for_log inconclusive error, boundary `log_window_evicted`, and the logcat tool never reads). Registration done.
- **Discipline:** no new abstractions beyond the one module plus `LogWindowOpenError`/`logWindowFromMarker`/`LogWindowEvictedError`/`collectPreparationLogWindow` (each exists because a site or test needed it). The `loopCriteriaInEvidenceSafeOrder` partition is kept (its test still holds); only its rationale comments were corrected.
- **Testing:** recording fixtures only; no real adb; every site case asserts the no-clear claim; RED and GREEN logs retained.
- **Descriptions:** none of the new src text contains the literal shell clear phrase, which the guard's second regex would flag.

## Concerns (disclosed, not red)

1. **`-t 4000` and eviction on a busy device.** logd applies `-t N` to the selected buffers *before* the client-side tag filter, so a chatty XR runtime can push the marker out of a 4000-line tail during a long poll (`probe_planes` up to 60 s, `assert_logcat` up to 180 s, `build_and_run`'s settle). The behaviour is then an honest `inconclusive`, never a wrong pass — but it is a possible usability regression versus the (forbidden) clear. Sites can pass a larger `maxLines`; I kept the brief's default everywhere pending a measured line rate on the emulator.
2. **Boundary prepare's streaming collector now begins with whatever the buffer already holds** (nothing is erased). Its `MAX_LOG_BYTES` is 64 MB and `scanPackageRuntimeHealth` scopes on the BoundaryExperiment `appStartMarker`, so correctness holds, but `prepare-logcat-all.txt` will be larger than before on a device with a big backlog. No runtime fixture drives the production `collectPreparation` (it needs a macOS qemu window binding); coverage is the exported helper's unit test plus the source pins.
3. **AGENTS.md's "70 of the 97 `test/*.mjs` files carry a … `../dist/` import" sentence** is now **71 of 98** by the command it quotes. No gate asserts it (checked), and this task does not edit docs — handing the numbers to Task 6.
4. **`build_and_run` inconclusive is an `isError`** even though build/install/launch succeeded; the report so far (steps, any PID-scoped crash lines) rides in the error text. Chosen because the typed success contract (`health: ok|CRASHED`) cannot express "unknown".
5. `assert_logcat` without `sinceMarker`/`clearFirst` still matches the whole buffer (compatible behaviour; it never cleared) and reports `logWindow: null` — callers wanting scoping must opt in, as `pico_loop` now does.
