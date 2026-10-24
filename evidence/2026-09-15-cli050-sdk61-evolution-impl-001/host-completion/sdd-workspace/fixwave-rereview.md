# Fix-wave FW1 re-review — `0f163f5..e474048` (2026-09-16)

Read-only in `.worktrees/cli050-sdk61-evolution-2026-09-15`. No working-tree, index, HEAD or branch
mutation; no emulator, device, host adb server, MCP tool, managed CLI store or registry contact. One
focused test file run (`PICO_ADB=/fixture/no/such/adb node --test test/logwindow.mjs`) and one
in-process probe of `knownRealAdbs` over scratch directories. This file is the only thing written.

### Finding Verdicts

**IMPORTANT 1 — long pollers pass a larger `maxLines`; the module's two doc sentences become true** —
ADDRESSED.
- `src/adb.ts:454` — `maxLines: z.number().int().min(100).max(200000).optional()` on `assert_logcat`,
  description states logd applies `-t` before the tag filter and that the default is 20000;
  `:470` `const bound = maxLines ?? LONG_POLL_LOG_WINDOW_MAX_LINES`; `:500` the read sends it;
  `:540-542` the inconclusive result carries `maxLines` and the hint names the bound.
- `src/agentloop.ts:147,154,174,202` — the same input, bound, read and text on `wait_for_log`.
- `src/workflow.ts:426` — `build_and_run`'s global correlation read is
  `readLogWindow(runner, window, { maxLines: LONG_POLL_LOG_WINDOW_MAX_LINES, timeoutMs: 60_000 })` (20000).
- `src/doors.ts:1110` — every `assert_logcat` `pico_loop` issues carries
  `maxLines: BUILD_LENGTH_LOG_WINDOW_MAX_LINES` (50000); import at `:12`.
- `src/logwindow.ts:29-40` — the two false sentences are replaced: module default named (4000) with its
  callers, then each long-poll caller and its bound; `:45/:47/:49` the three constants; `:116-128`
  `readLogWindow` itself unchanged.
- Tests: `test/logwindow.mjs:484` (schema shape, `-t 20000` default, `-t 500`/`-t 50000` verbatim,
  `maxLines: 10` refused and nothing run), `:517` (wait_for_log), `:544` (constants + the single
  `readLogWindow(runner, window, {…})` in `src/workflow.ts` pinned to the long-poll bound),
  `:697-728` (`pico_loop` passes 50000 on every recorded call), `test/smoke.mjs:193-205`
  (behavioural: the recorded `logcat -d -v threadtime -t 20000` argv, PID dump excluded).
- Check I ran: `node --test test/logwindow.mjs` → 29 tests, 29 pass, 0 fail (independent of the report).
- Check I ran: the RED logs match the claims — `step1-red-bounds-logwindow.log` 22 tests / 4 fail,
  `step1-red-bounds-smoke.log` records `"logcat","-d","-v","threadtime","-t","4000"` with the new check
  FAIL; `step3-green-bounds-smoke.log` records `-t 20000`, `Failures: 0`.

**MINOR 1 — the four polling sites retain the dump error instead of blaming eviction** — ADDRESSED.
- `src/logwindow.ts:132-146` `unseenMarkerCause({successfulDumps,lastReadError})`: all-failed →
  `every dump failed: <error>; no dump succeeded, so nothing is known about the marker` with no
  eviction claim; mixed → eviction plus `the last dump also failed: … (N dump(s) succeeded …)`;
  `:20-24` the module semantics paragraph states the rule.
- Sites: `src/adb.ts:493-508,541-542`; `src/agentloop.ts:168-182,201-202`; `src/sense.ts:597-611,627`;
  `src/copilot.ts:91-104,133`. Counter placement is correct at all four (`sense.ts` increments after the
  `catch { … continue }`, the other three inside the `try` after the await).
- Tests: `test/logwindow.mjs:566` (unit), `:578` assert_logcat, `:613` wait_for_log, `:629` probe_planes,
  `:646` live_scene_snapshot — each asserts `/every dump failed: .*fixture dump failure/`,
  `doesNotMatch /evicted/`, `markerSeen:false` and no clear; `:596` the mixed case. The `dumpFails`
  scenario is the pre-existing fixture at `test/logwindow.mjs:87` (unchanged by this wave).
- The disclosed deviation (conditional wording, not a pure append) is the right call and still contains
  the brief's literal `every dump failed: <message>`.

**MINOR 3 — inverted, content-first logcat-clear guard** — ADDRESSED.
- `test/logwindow.mjs:806-870`: `CLEAR_SPELLINGS` keeps both regexes the old guard used;
  `findLogcatClearSites` scans every `src/*.ts`; `assertOnlyExplicitSerialClear` asserts exactly one
  site, in `adb.ts`, matching `await adb(["-s", target, "logcat", "-c"])`, inside an `if (clear) {`
  branch that derives `const target = serial?.trim() ?? ""`, has `if (!target) {` and a
  `return fail(… explicit serial`. No line number is pinned.
- Tests: `:845` on the real source, `:850` five synthetic negatives (a second clear in each of the three
  spellings, the clear moved to another file, `resolveSerial` substituted, a resolved-serial argv).
- Check I ran: `find src -mindepth 1 -type d` → none, and no `.ts` below top level, so `src/*.ts` covers
  every source file; the one real site is `src/adb.ts:382` and both guard tests pass in my run.

**MINOR 4 — the `PICO_GATE_FIXTURE_ADB` hatch refuses a real adb** — ADDRESSED.
- `scripts/gate-inventory.mjs:63-65` (`ADB_BASENAMES`, `REAL_ADB_SCAN_DEPTH = 3`), `:67-81`
  (`realpathOrNull`/`isFile`), `:83-119` `knownRealAdbs(env)` over PATH directories (with the Windows
  `Path` fallback), `$PICO_HOME` and `~/Library/PICO` to depth 3, `:136-155` `gateChildEnv` refusing with
  the same `GATE_FIXTURE_ADB_INVALID` code and `must not be a real adb — it resolves to <realpath>, the
  adb found in <where>`; `scripts/run-gate.mjs:188` fix text now ends `— never a real adb`;
  `AGENTS.md:63-65` states the refusal.
- Tests: `test/gate-inventory.mjs:518` (temp fake passes), `:524` (same fake first on the caller's PATH
  refused; `adb.exe` too), `:535` (symlink to a PATH adb refused by realpath), `:546` (three levels under
  `$PICO_HOME` refused, four not searched, `~/Library/PICO/sdk/platform-tools/adb` refused), `:565`
  (native-contract returns the identical object), `:572` (run-gate exit 2, nothing spawned, new fix
  text), `:633` (the pre-existing invalid-override case asserts the full new text). Each new case builds
  its own PATH/PICO_HOME/HOME in temp directories.
- Checks I ran on the named risk (a): `scripts/gate-inventory.mjs` imports no `child_process` and makes
  exactly five fs calls (`accessSync`, two `statSync`, `realpathSync`, `readdirSync`) — nothing is
  spawned; an in-process probe with a `chmod 000` directory under `$PICO_HOME` returned 0 finds without
  throwing, a non-directory `$PICO_HOME` likewise; and with an injected `knownRealAdbs` that throws if
  called, `gateChildEnv(gate, {PICO_ADB:"/real/adb"})` returned `PICO_ADB=/fixture/no/such/adb` without
  calling it — the scan runs only when the override variable is set.

**MINOR 5 — `pico_look` names its retained default and its lack of a serial input** — ADDRESSED.
`src/doors.ts:534` carries the exact sentence "Default target emulator-5554 (retained this checkpoint);
this door has no serial input." after the first sentence; the door still forwards `capture_canonical {}`.
Test `test/doors.mjs:717-724` pins the sentence and `inputSchema.properties` being empty;
`step8-red-picolook.log` shows the isolated RED.

**MINOR 6 — AGENTS.md `gates.yml` wording** — ADDRESSED. AGENTS.md now reads "`gates.yml` keeps the same
value at workflow level; it is the barrier only for the one raw `node --test` step (run-gate replaces it
for every gate child). A direct `node --test test/<file>.mjs` gets neither, so export it yourself."
(`AGENTS.md:67-69` at current HEAD). `gate-test-distribution-adoption.log` 43/43 and
`gate-test-docsmeta.log` 26/26 with `Failures: 0`.

**MINOR 2 (partial) — untrack the gitignored SDD working file** — ADDRESSED. Commit `3b6679d`
`chore: untrack a gitignored SDD working file` removes only
`.superpowers/sdd/2026-09-16-cli050-host-completion/task-5-report.md` from the index (385 deletions, no
other path). Checks I ran: the file is on disk (26,620 bytes); `git ls-files` lists zero tracked files
under that SDD directory; `git merge-base --is-ancestor 0f163f5 HEAD` succeeds, so no history rewrite;
`git diff --diff-filter=DM 0f163f5..e474048 -- evidence/` is empty, so nothing under `evidence/` was
modified or deleted. All seven commits carry `Co-Authored-By: Claude Fable 5.1`.

### New Breakage in the Fix Diff

**Cosmetic — `AGENTS.md:65` at the reviewed head is 127 columns**, and the fix-wave report claims "Lines
≤100 columns (the 101-column line 63… is pre-existing text, untouched)". Measured: at `0f163f5` the
over-100 lines are 42, 45, 51 (101 each) and 99 (the 225-column stamped tool-count sentence); at
`e474048` the new hatch clause added a 127-column line 65. No gate enforces markdown width, so nothing
was red, and two commits after the reviewed head (`c68979d`, `1c752d2`) re-wrapped the paragraph — the
current HEAD has no line over 100 except the pre-existing three and the stamped sentence. The defect is
in the report's accuracy, not in the tree as it stands.

**Low — the new `maxLines` input is silently inert on the unwindowed path of both tools.**
`src/adb.ts:495` (`dumpArgs`, reached when `clearFirst:false` and no `sinceMarker`) and
`src/agentloop.ts:185` (`clearFirst:false`) still dump the whole buffer with no `-t`, so a caller that
passes `maxLines` there gets no bound and no diagnostic. Neither description says the bound applies only
to a windowed read.

**Low — `unseenMarkerCause` still says "evicted" when nothing was attempted.** With
`successfulDumps === 0 && lastReadError === null` (`src/logwindow.ts:139-145`) it returns the plain
eviction text. Only reachable if a poll loop never iterates (a deadline already passed on entry), which
today's `timeoutSec.min(1)` / `waitSec.min(3)` make near-impossible — but it is the same misattribution
class the finding removed, one edge smaller.

**Low — two pre-existing hatch tests now read the host's real `~/Library/PICO` and `/usr/bin`.**
`test/gate-inventory.mjs:486` and `:597-605` pass env objects with no `HOME`, so `knownRealAdbs` falls
back to `os.homedir()` (`scripts/gate-inventory.mjs:118`) and walks the real `~/Library/PICO` to depth 3;
the second also names `PATH: "/usr/bin"`. Named risk (e): the assertions cannot vary by machine — the
override in both is a freshly created temp file whose realpath can never equal a real adb — so this is
host I/O, not flake. The six new cases are hermetic; these two would be too with one `HOME: tempDir(t,…)`.

Named risks (b), (c), (d) came back clean:
- (b) no prior assertion pinned an argv bound: `assertBoundedWindowDumps` (`test/logwindow.mjs:163-177`)
  asserts only `Number(dump[t+1]) > 0`, and the only `4000` assertion in the suite is the new
  "module default is unchanged" at `:546`.
- (c) the guard scans every `src/*.ts` and asserts `sites.length === 1`, so a second clear anywhere in
  `src/` fails it (proved by the three synthetic spellings at `:850`); `src/` has no subdirectories.
- (d) `src/doors.ts:1110` is the only `call("assert_logcat", …)` in `src/` outside `adb.ts` itself, and
  it sits in the single `c.kind === "logcat"` branch (`:1105`), so every criterion path that issues an
  `assert_logcat` carries the 50000 bound; patternless logcat criteria are refused earlier (`:998`).

Additive result fields are safe: neither `assert_logcat` nor `wait_for_log` declares an `outputSchema`.
No caller passes a partial `io` to `gateChildEnv` (`scripts/run-gate.mjs:185` and every test call site
use the default), so the widened injection seam breaks nothing.

### Out-of-Scope Observations

- The branch has moved past the reviewed head: `HEAD` is `1c752d2`, two AGENTS.md re-wrap commits after
  `e474048`; working tree clean. `dist/` is current (`verifyBuild` → `{current:true,reasons:[]}`) and
  carries the new constants, so my focused run exercised the fixed sources.
- `src/boundaryexperiment.ts:417` reads its `-b all`, untagged prepare window at the 4000 default and is
  named in neither of `logwindow.ts`'s new caller lists (the default list names assert_scene,
  probe_planes, live_scene_snapshot). Harmless in practice — the read immediately follows the marker
  write — but it is a fourth default-bound site the doc does not account for.
- `probe_planes` accepts `waitSec` up to 60 (`src/sense.ts:569`) while the new doc classifies it as a
  short, tag-filtered read. The doc is self-consistent (it explicitly assigns probe_planes to the
  default), and the finding named only three sites, so this is a residual, not a regression: it is the
  one remaining poller that can run a minute on a 4000-line raw tail.
- The inverted guard trades the line-number pin for a 20-line proximity pin
  (`test/logwindow.mjs:830`): the `if (clear) {` branch must stay within 20 lines above the clear.
  Far less brittle than `adb.ts:382`, but still a structural coupling worth knowing about.
- For T6's CHANGELOG, the wire contract the fix adds is as the report lists it: `maxLines`
  (100..200000, default 20000) on `assert_logcat` and `wait_for_log`; `assert_logcat`'s inconclusive
  result gains `maxLines` and `dumps:{succeeded,lastError}`; inconclusive hint/error wording changed at
  four sites; `pico_loop` sends 50000; `build_and_run` reads with 20000; the hatch refusal and its fix
  text changed.

### Verdict

**Fix round:** All findings addressed, no new Critical/Important breakage.
Open items: none blocking. Three Low notes above (inert `maxLines` on the unwindowed path; the
zero-attempt branch of `unseenMarkerCause`; two non-hermetic pre-existing hatch tests) and the
report-accuracy point on AGENTS.md line width, already remediated on the branch.
