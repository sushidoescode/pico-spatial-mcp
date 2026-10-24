# Task 4 review — bounded, correlated log observation (070e4a8..80fb227)

### Spec Compliance

- ✅ Spec compliant. All nine sites the brief enumerates are replaced, the one destructive clear is
  kept and hardened, both folded-in Task-1 items are done, and the three deviations from the brief's
  letter are each documented **and** verified necessary (below).
- ⚠️ Cannot verify from diff: the `Co-Authored-By: Claude Fable 5.1` trailer on both commits — the
  review package carries subjects only (`review-070e4a8..80fb227.diff:3-5`) and I was told not to run
  git commands. ⚠️ Also unverifiable by design: any on-device behaviour (eviction rates, `log -t`
  availability on a real PICO image) — no emulator or device was touched, which the brief required.

Per-requirement check, with the line I read:

| Requirement | Verdict |
|---|---|
| assert_scene window before the broadcast | ✅ `src/assertscene.ts:88` (open) → broadcast → `:102` (read) |
| probe_planes: one window, every poll re-reads it | ✅ `src/sense.ts:582`, `:601` |
| copilot snapshot | ✅ `src/copilot.ts:79`, `:94` |
| build_and_run: window before launch | ✅ `src/workflow.ts:391` (after force-stop, before `am start`/monkey) |
| pico_loop: marker via `adb_shell`, `sinceMarker` on every assert | ✅ `src/doors.ts:1045`, `:1103` |
| assert_logcat `sinceMarker` + `clearFirst` re-described | ✅ `src/adb.ts:456-457`, `:470-489` |
| wait_for_log default `clearFirst` opens a window | ✅ `src/agentloop.ts:141`, `:155` |
| boundary prepare `-b all` window | ✅ `src/boundaryexperiment.ts:411-422`, called at `:3047` |
| the ONE clear stays, explicit serial required | ✅ `src/adb.ts:378-384` — the refusal is checked **before** `resolveSerial`, so a refused clear runs no adb at all |
| `markerSeen:false` ⇒ inconclusive, never the unscoped buffer | ✅ at all 8 observation sites (assertscene:110, sense:612, copilot:121, workflow:485, adb:522, agentloop:191, doors:1106, boundaryexperiment:420) |
| module owns the logic, exports the 5 named symbols | ✅ `src/logwindow.ts` (128 lines): `LOG_WINDOW_TAG`, `LogWindow`, `openLogWindow`, `readLogWindow`, `sliceAfterMarker`, `newLogMarker` |
| `readLogWindow` bounds the dump, never `-c` | ✅ `src/logwindow.ts:103-105` always appends `-d -v threadtime -t <maxLines>`; no `-c` anywhere |
| source guard pins one clear by file:line | ✅ `test/logwindow.mjs:605-616` pins `["adb.ts:382"]` **and** re-asserts line 382's text |
| `test/logwindow.mjs` registered in `test:observation` | ✅ `scripts/gate-inventory.mjs:175` |
| incident records untouched | ✅ no `docs/` path in the diff's file list |
| recording fixtures only; every site asserts no `logcat … -c` | ✅ `assertNoClear` (`test/logwindow.mjs:149-157`) called in every site case; fixture adb exits 97 on a clear (`:60-65`) |
| nothing under `evidence/` modified or deleted | ✅ 27 `new file mode` entries, zero `--- a/evidence` or `deleted file` lines in the diff |
| version stays 38.0.0 | ✅ `package.json` is not in the diff |
| folded item: "Nine doors" | ✅ `test/doors.mjs:247` |
| folded item: `dependencies !== undefined` | ✅ `src/doors.ts:388` with the rationale comment |

Three deviations from the brief's letter, each verified required:

1. **Sidecar is `prepare-log-window.txt`, not `prepare-logcat-all.txt`** (`src/boundaryexperiment.ts:3039`).
   Verified: `collectLogWindow` refuses a pre-existing artifact — `if (fs.existsSync(checkedTarget)) throw`
   at `src/runtimecontinuity.ts:1217` — so writing the window read into the streaming collector's own
   path would have thrown on every run. The brief's exact header line is preserved (`:418`). Nothing
   consumes either filename by name (grepped `src/`, `test/`; no `readdirSync(artifactRoot)` check exists).
2. **`build_and_run`'s PID-scoped read is not routed through the window** (`src/workflow.ts:422`).
   Verified correct: the marker is written by a transient `adb shell log` process, so a `--pid <app>`
   dump can never contain it; forcing it through `readLogWindow` would make every run inconclusive.
   Only the global crash-correlation read goes through the window (`:424`), which is what the
   constraint is actually about.
3. **`wait_for_log`'s matched result is now JSON** (`src/agentloop.ts:180-187`). Verified no caller
   breaks: the only other mention of `wait_for_log` in `src/` is prose (`src/prompts.ts:238`); nothing
   parses its text. Same check for the other two shape changes — `copilot.ts`'s `snapshot()` has
   exactly one caller (`src/copilot.ts:213`, updated), and `runAssertScene`'s second caller
   (`src/verify.ts:70`) branches on `"error" in a` and is unaffected by the added fields.

### Strengths

- The evidence semantics are right everywhere, which is the whole point of the task: no replaced path
  can turn a stale line into a pass. I traced each of the eight unseen-marker branches individually,
  including the three subtle ones — `src/sense.ts:607` keeps a previously-parsed inventory but still
  returns inconclusive at `:612` rather than shipping it; `src/doors.ts:1106` checks **both**
  `status === "inconclusive"` and `logWindow?.markerSeen === false` and maps to `unmeasurable`, so an
  inconclusive read can never drive a replan; `src/workflow.ts:440` feeds `analyzePackageRuntimeLogs`
  an empty global string when the marker is missing rather than the unscoped dump.
- Real TDD, not a retrofit. `step2-red-logwindow.log` is a genuine `ERR_MODULE_NOT_FOUND`;
  `step4-red-sites.log` is 4 pass / 14 fail against the *unchanged* sites with per-case assertion
  diffs (e.g. `manual-repair-required` vs `unmeasurable-acceptance`), and `step4-green-sites.log` is
  18/18 on the same file. The RED run proves the fixtures had teeth before the code moved.
- The recording fixture is the right shape: it records argv, records and echoes back only the markers
  it was actually asked to write (so an unopened window reads as evicted for free), refuses untargeted
  commands, and trips a 97-exit tripwire on any clear. `gate-smoke.log`'s `SMOKE_SUMMARY` shows the
  real `build_and_run` argv sequence — `shell log -t pico-mcp <uuid>` → monkey →
  `logcat -d -v threadtime -t 4000` → `logcat --pid 4242 -d` — with no clear anywhere.
- `src/logwindow.ts:35-39` documents the one thing that actually makes this fragile (logd applies
  `-t N` before the client-side tag filter) instead of hiding it, and the module header cites the
  incident that motivated the change.
- The destructive clear is genuinely hardened, not just re-worded: the serial check precedes
  `resolveSerial` (`src/adb.ts:376-381`), and `test/logwindow.mjs:497-502` proves a refused clear
  records *zero* adb calls, blank/whitespace included.
- Comment archaeology was done honestly — `src/doors.ts:104-109`, `:1069-1071` and `test/doors.mjs:505-509`
  now say the criterion partition is *kept for shape*, rather than leaving three comments asserting a
  clear that no longer exists.

### Issues

#### Critical (Must Fix)

None.

#### Important (Should Fix)

None.

#### Minor (Nice to Have)

1. **Four polling sites swallow the dump error and then blame eviction for it.**
   `src/adb.ts:498-500`, `src/agentloop.ts:172-174`, `src/sense.ts:602-604`, `src/copilot.ts:95-97`
   all `catch { … }` with no retained error. When the dump fails on *every* poll (device unplugged,
   adb server died), `markerSeen` stays `false` and the deadline branch reports
   "the log window marker … was never seen in the bounded dump (evicted by log volume, or never written)"
   (`src/adb.ts:529`, `src/agentloop.ts:192`). The verdict is safe — inconclusive, never a match —
   but the stated cause is wrong and points an operator at log volume instead of a dead device.
   `readLogWindow` throws a descriptive message (`src/logwindow.ts:113`) that is discarded. One-line
   fix: keep `lastReadError` and append it to the inconclusive hint. (`src/workflow.ts:429-431` and
   `src/assertscene.ts:104` already do report the dump failure distinctly — this is the polling sites only.)

2. **No site raises `maxLines` above the 4000 default, including the two unfiltered reads.**
   Grepped all seven call sites: none passes `maxLines`. The exposure is proportional to how long the
   window stays open — `src/workflow.ts:424` reads the *unfiltered* global tail across the whole settle,
   and `src/adb.ts:495` polls up to 180 s behind a tag filter that logd applies only *after* `-t`. The
   result is an honest inconclusive (and for `build_and_run` an `isError` even though build/install/launch
   succeeded), so nothing is over-claimed, but it is the change most likely to bite on a chatty XR
   runtime. `src/boundaryexperiment.ts:417` is fine — its write and read are consecutive adb calls.
   Disclosed as report concern 1; worth a larger bound at `workflow.ts:424` before this meets a real device.

3. **The report understates the boundary-prepare consequence.** Concern 2 says the prepare stream will
   merely be "larger". In fact `collectLogWindow` spawns a streaming `logcat -b all -v threadtime` with
   no `-T` (`src/runtimecontinuity.ts:1222`), so it now replays the entire un-cleared backlog into the
   artifact, and `checkedLogWindow` treats a truncated window as a **hard run failure**
   (`src/boundaryexperiment.ts:2504-2506`), not a note. The 64 MB budget
   (`src/runtimecontinuity.ts:24`) makes this unlikely, so it stays Minor — but the failure mode is an
   aborted experiment, not a big file, and the handoff should say so.

4. **`pico_loop`'s own report carries `{ marker }` without `markerSeen` or `serial`**
   (`src/doors.ts:1179`). The constraint asks every replaced site to report
   `logWindow: { marker, markerSeen }` and `serial`; here both live only inside the inner
   `assert_logcat` results, which the iteration log does not surface. The brief's site-specific step
   for `doors.ts:1016` is satisfied exactly, and the inconclusive detail string names the marker
   (`:1109`), so this is presentation, not behaviour.

5. **Two `probe_planes` failure paths stayed unstructured.** `src/sense.ts:580` (broadcast failed) and
   `src/sense.ts:620` (no `PLANES|` dump) return prose; they name the device and, in the second case,
   the marker, but not `serial`/`logWindow` as fields — unlike the success and inconclusive paths.

6. **`src/assertscene.ts:97` reports `markerSeen: false` on a broadcast failure**, where no read was
   attempted at all. Conservative and harmless, but it conflates "not read" with "marker absent";
   `null` would match the shape the open-failure branch uses two lines earlier.

7. **`AGENTS.md`'s "70 of the 97 `test/*.mjs` files" sentence is now stale** — I ran the exact command
   it quotes against this tree: 98 files, 71 with a `../dist/` import. This task's `test/logwindow.mjs`
   is what moved it. I confirmed the implementer's claim that no gate asserts the sentence (grepped
   `test/`, `scripts/`), and they explicitly handed it to Task 6; recording it here so it is not lost.

8. Nit: `dumpArgs` (`src/adb.ts:492`) is still built on every call even when a window makes it dead.

### Checks I ran (beyond reading the diff)

- **Named risk (a) — a differently-spelled clear the guard's regex would miss.** `src/` has no
  subdirectories (`find src -type d` → `src` only), so the guard's top-level `readdirSync` covers all
  192 `.ts` files. Grepping `"-c"` across all of them returns only `monkey -c android.intent.category.LAUNCHER`,
  `sh -c`, `stat -c`, `python -c` — and `src/adb.ts:382`. No `'-c'` or backtick spelling exists. Also
  checked `scripts/`, `tools/` and `test/`: the only survivors are the guard patterns themselves and
  `test/verifyapk-observation.mjs:533`, a pre-existing per-file no-clear assertion. **No missed site.**
- **Named risk (b) — `-t <N>` versus the tag filter.** Confirmed the module always appends the marker
  tag when any tag is given (`src/logwindow.ts:107-111`) and carries *no* filter when none is given,
  which is correct: a `pico-mcp:V *:S` filter on a tagless read would hide the very lines being awaited.
  Confirmed no site can match stale lines when the marker is missing (the eight branches listed above).
- **Named risk (c) — the boundary streaming collector.** Read `collectLogWindow`
  (`src/runtimecontinuity.ts:1207-1290`): it streams `-b all` with no `-c` and no `-T`, so it still
  receives everything it needs plus the backlog; its `appStartMarker` is emitted *after* the child
  starts, so `appStartMarkerObserved` is unaffected. The test's ordering pin
  (`test/boundaryexperiment.mjs:3030-3033`) enforces window-before-collector. See Minor 3 for the
  truncation consequence.
- **Named risk (d) — `wait_for_log`'s new JSON shape.** No `src/` caller parses it (only
  `src/prompts.ts:238`, prose). Also checked the two other changed shapes (`snapshot()`, `runAssertScene`).
- **Growth.** `src/adb.ts` 618 lines, `src/doors.ts` 1255, `src/boundaryexperiment.ts` 4052. The
  per-file additions (≈66 / ≈40 / ≈38 net) are the minimum each site needs; nothing was refactored
  sideways, and the shared logic really does live in the new 128-line module. The one judgement call
  is putting `collectPreparationLogWindow` inside the 4052-line `boundaryexperiment.ts` rather than
  in `logwindow.ts` — defensible, since it depends on that module's private artifact writer.
- I did not re-run the suite. I read `step2/3/4/5` and the 19 gate logs in the evidence tree; no
  warnings or skips beyond the one pre-existing skip the report names in `test:emulator-restart`.

### Assessment

**Task quality:** Approved

**Reasoning:** Every implicit clear is gone (independently verified, not just by the task's own
guard), every replaced path reports an honest inconclusive instead of matching the unscoped buffer,
and the RED→GREEN evidence shows the fixtures had teeth before the code moved. The remaining items
are diagnostic-message and reporting-shape polish plus one under-stated handoff note — none of them
can produce a false verdict.
