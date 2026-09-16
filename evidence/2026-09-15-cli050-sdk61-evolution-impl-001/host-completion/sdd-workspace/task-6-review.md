# Task 6 review — 1c752d2..2a6f494 (host-only completion pass, checkpoint + battery + artifact)

### Spec Compliance

- ✅ Spec compliant. Every requirement of the dispatch, the brief and spec item 6 is present and
  true against the tree, the logs and the receipts. No Critical or Important finding.
- **(1) Description/comment-only source edits** — `src/adb.ts:456` (`assert_logcat` `maxLines`) and
  `src/agentloop.ts:147` (`wait_for_log` `maxLines`) now open "Bound on each raw dump … of a
  WINDOWED read" and state the input is inert without a window; one inline comment each at
  `src/adb.ts:470` / `src/agentloop.ts:143`. `src/logwindow.ts:30-33` and the
  `DEFAULT_LOG_WINDOW_MAX_LINES` doc comment (`src/logwindow.ts:46`) now name the boundary-prepare
  read. Checked the claims are true, not just written: the unwindowed branch at `src/adb.ts:511-513`
  dumps `["-s", s, "logcat", "-d", …]` with no `-t`, so `maxLines` really is inert there; the
  boundary prepare read at `src/boundaryexperiment.ts:417` passes `{ buffers: ["all"] }` with no
  `tags` and no `maxLines` (default bound, untagged, `-b all`) and immediately follows
  `openLogWindow` at `:416`. No constant, schema range, default or code path moved.
- **(2) Doc corrections** — CHANGELOG 38.0.0 replaced the false run-gate clause (`grep "unless the
  caller set one" CHANGELOG.md` → gone; the only surviving copies are the historical
  `docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md:74` and the new checkpoint's two
  forward-pointer rows that quote it). AGENTS.md:24 re-derived. Capability matrix `perf live run`
  row + §2 Performance gained the device pass-through.
- **(3) Targeted gates on the final source** — 18 gate logs + build + `verifyBuild` under
  `evidence/…/host-completion/task-6/`; I read the trailing `exit=` line of all 37 logs: every one
  is `exit=0`.
- **(4) Full battery, no `PICO_ADB`, tripwire adb** — 55/55, verified below.
- **(5) Fresh artifact + receipt, earlier tarballs byte-unchanged** — verified below.
- **(6) Checkpoint** — `docs/findings/CLI050_HOST_COMPLETION_CHECKPOINT.md` (384 lines) carries
  every item the final review's Recommendation 2 lists (T3 incident, the `PICO_GATE_FIXTURE_ADB`
  hatch + guard, the twelve `/tmp/pico-render` defaults, marker eviction, boundary-prepare
  backlog/truncation, `adb-resolution` reachability, retained default targets, the docsmeta ENOTDIR
  noise, `emulator_look`'s untested runtime path) and everything Recommendation 3 requires of the
  CHANGELOG (all thirteen contract items, incl. the replaced `:82-83` sentence). Recommendation 4's
  version caveat is recorded unwaived at `…CHECKPOINT.md:55-60`. Recommendation 5's battery hygiene
  is the method actually used.
- **Global constraints** — `git diff --diff-filter=DM --name-only dfb3f2d..2a6f494 -- evidence/` →
  0 files; `git diff --name-only dfb3f2d..2a6f494 -- docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md`
  → 0 files; `git status --short --untracked-files=all` → empty (the three `.tgz` are gitignored);
  version stays 38.0.0 in every manifest (step7 docsmeta asserts 12 version sites). Trailers not
  re-checked, per instruction.

### Checks I ran (every named risk)

**(a) Per-task table vs ledger, task reports and `git log dfb3f2d..2a6f494`.** All 38 commit SHAs
cited in the per-task rows exist on the branch and are attributed to the right task (T1 `641ec84`,
`0af0055`, `313c03a`, fold-in `33ec6b8`, evidence `070e4a8`; T2 `06c71ca`, `fba0a6d`, `c13fea6`,
merge `c6f6cef`; T3 `b6d8d63`, `e36cb68`, `8956eae`, merge `37daef2`; T4 `c5662f3`, `80fb227`;
T5 `0c9c6e5`, `6691d14`, `f437500`, `cf0da79`, fixes `e1ae6c5`, `0f163f5`; FW1 `3b6679d`, `0cb2b71`,
`9c26b2f`, `7ec1fa0`, `9d26429`, `a6712a1`, `e474048`, `c68979d`, `1c752d2`; T6 `896b589`,
`54ce696`, `4022939`, `61b8bde`). `git rev-list --count dfb3f2d..2a6f494` = **38** (matches
`…CHECKPOINT.md:36`), and `dfb3f2d..61b8bde` = **37** — so the self-correcting commit `2a6f494`'s
own subject is accurate. Every review verdict and Minor count matches `progress.md` exactly
(T1 opus 0/0/12; T2 sonnet 0/0/3; T3 sonnet 0/0/4; T4 opus 0/0/8; T5 opus spec ❌ 2 Important /
6 Minor + one fix round + sonnet re-review; FW1 fable 0C/1I/11M, opus re-review, 7 items addressed).
Test counts match too, including ones the ledger does not carry: `task-1-report.md:58,60` confirms
`test:sdkselection` 176/176 and doors 17/17 at T1. Evidence-directory file counts in the checkpoint
(26 / 14 / 19 / 25 / 40 / 7 / 36) match `ls` exactly for task-1..task-5, merge-t2-t3 and fixwave.

**(b) Battery.** `battery-38.0.0-host-completion.runner.out` lists `PASS 1/55` … `PASS 55/55` and
`BATTERY PASS 55/55 (0 failed)`; no skip summary is appended, so no gate was skipped. In the 450 kB
aggregate log the ENOTDIR line appears exactly once (line 3288, inside `test:docsmeta`); the only
`# SKIP` is `frontmostQemu … off Darwin` (line 2717, `skipped 1` at 3234); both native suites really
ran their contracts (lines 2462-2477 print the compiled-contract summaries, not the off-Darwin
no-op), and `test:vcamreader-native` prints the exact "reader is authorized; skipping the
readback-block assertion to stay device-free" line the checkpoint quotes. No real-adb signature
anywhere: no `List of devices attached`, no `daemon not running`/`daemon started`, no adb-server
text; the `emulator-5554` occurrences are fixture payloads. `step4-battery-preconditions.log` shows
`PICO_ADB … <unset>`, `which adb` = the tripwire, `PATH[0]` = the tripwire dir, HEAD `54ce696`
(i.e. after both source commits — the battery did run against the final source). The tripwire marker
`step4-tripwire-adb-marker.txt` **does not exist** in the tree today.

**(c) Receipt.** `…/release/host-completion/pico-spatial-mcp-38.0.0.tgz.receipt.json` carries exactly
what the checkpoint quotes: sha256 `ff394fbb…8d042`, 2,176,424 bytes, build input
`bafeb2712c5b…` / 197, output `f4978b711f57…` / 192, TS 5.9.3 / nodeMajor 25, darwin-arm64 v25.8.1,
48 checks all `pass` (incl. "installed server listed exactly 255 tools for darwin", "doors surface
registered all 18 door tools", "packed dist/build-receipt.json binds the payload to source
bafeb2712c5b / output f4978b711f57"). Build-input identity vs the current tree: I re-hashed all 197
entries of `dist/build-receipt.json` — 195 real files match byte-for-byte, the two non-matches are
the synthetic `toolchain:node-major` / `toolchain:typescript` pseudo-entries. So the published
artifact is bound to the source that is checked out now. `shasum -a 256` on the three tarballs
returns `941e402b…`, `c08e1a8b…`, `ff394fbb…` with 2,158,783 / 2,161,859 / 2,176,424 bytes, and the
two earlier receipts carry `e51cb8f1b72b`/195 → `68a3d0a73884`/190 and `eb105535d137`/195 →
`5d245218bf71`/190 with 48/48 — i.e. every cell of the lineage table at `…CHECKPOINT.md:318-320` is
correct, and all three `command.argv` fields show `node scripts/verify-tarball.mjs --publish <abs>`
from this worktree, as line 313 claims.

**(d) CHANGELOG vs code, three spot-checks.** `maxLines`: `z.number().int().min(100).max(200000)`
with `LONG_POLL_LOG_WINDOW_MAX_LINES` 20000 / `DEFAULT_LOG_WINDOW_MAX_LINES` 4000 /
`BUILD_LENGTH_LOG_WINDOW_MAX_LINES` 50000 passed by `pico_loop` at `src/doors.ts:1110`; the
inconclusive result really carries `maxLines` and `dumps: { succeeded, lastError }`
(`src/adb.ts:541-542`); windowed-only scope confirmed at `src/adb.ts:511-513`.
`PUBLISH_NO_ATOMIC_PUBLICATION`: raised at `scripts/publish-tarball.mjs:172`, and `PUBLISH_IO`
(`:57-66`) has no `rename` member at all — the CHANGELOG's "removed from the publication IO itself,
not merely unused" is literally true. `requestedDevice`: `src/doors.ts:580` takes `device` and
forwards verbatim; `collectPerfLive` spreads `requestedDevice` onto every result
(`src/perfcli.ts:415`), the unavailable/SKIP path carries it (`:644`), the success adaptation
carries it (`:593`), and `DEFAULT_PERF_DEVICE = "emulator-5554"` is at `src/perfcli.ts:74` exactly as
the matrix and checkpoint cite. Also checked the other new bullets: `wait_for_log` matched result is
`okJson({matched:true,…,lines})` (`src/agentloop.ts:191-196`); `build_and_run` output schema
requires `serial` + `logWindow` (`src/workflow.ts:356`); `logcat clear:true` refuses without an
explicit serial at `src/adb.ts:378-382`; `PICO_RUNLOCK_CHILD_CLOCK_SCALE` is read at
`test/fixtures/runlock-child.mjs:234`; `capture_canonical`/`emulator_look` route through
`observationCapturePath` (`src/eye.ts:323`, `src/emulatorlook.ts:93`).

**(e) AGENTS.md count.** Ran the quoted command: `grep -lE '(from|import\()[[:space:]]*"\.\./dist/'
test/*.mjs | wc -l` → **71**; `/usr/bin/grep` same expression → 71; `ls test/*.mjs | wc -l` → 98.
AGENTS.md:24 says "71 of the 98". Correct.

**(f) Over-claim scan.** No sentence in the checkpoint or the CHANGELOG claims native, visual,
device, cross-platform or end-to-end evidence, and nothing calls the artifact "verified" in the LOOK
sense. The word "verified" appears only as (i) a code-behavior phrase ("never turns unknown
provenance into a verified installation identity"), (ii) "re-verified with `shasum -a 256`" (a byte
check, correctly `host-executed`), (iii) "unverified" for host-plugin discovery. `…CHECKPOINT.md:12-18`,
`:27` and `:377-384` state the negative explicitly, and the CHANGELOG preamble for the new bullets
repeats the same limit. The one "prove" is `test:doors` proving fixture refusals, scoped to the
fixture.

**One focused gate (allowed):** `PICO_ADB=/fixture/no/such/adb npm run --silent test:docsmeta` on the
final tree → 26 tests / 26 pass / 0 fail, i.e. the new checkpoint's relative links resolve and
`sync-metadata --check` reports no drift after the last commit. (The committed `step7-*` logs show
docsmeta 26/26 "all 189 relative markdown links resolve (77 git-tracked files)", lint 63/63 and
distribution-adoption 43/43, all `exit=0`, all timestamped 13:33Z — after `2a6f494`'s edit.)

**Corroborations I did not have to run but did:** the T3 incident record is exactly true —
`/tmp/pico-render/canonical.png` is 12,420 bytes, sha256 `457aadfa7d45e845…`, mtime Sep 16 03:25,
and `457aadfa7d45e845` is the documented `valid-small.png` fixture identity
(`evidence/…/sdd-workspace/task-C6-report.md:290`). The test-count-change table
(`…CHECKPOINT.md:292-301`) is right in every row: parsing both battery logs gives observation
48→79, lint 49→63, sdkselection 175→177, plugin-bootstrap-freshness 27→31, claims exit 1 →
exit 0, runrevision 327→327, emulator-restart 690/689/1 unchanged, and doors 17 / tarball 11 /
conformance 69 / docsmeta 26 / distribution-adoption 43 / picocli 22 / prompts 3 / buildfreshness 26
unchanged — and the 2026-09-15 runner really recorded `BATTERY FAIL 54/55 … 1 failed: test:claims
[exit 1]`, so "red by ruling → PASS" is an honest description. Every `file:line` citation I sampled
in the limits section resolves to what it says: `src/adb.ts:382` is the one `logcat -c`,
`src/nativefleetreceipt.ts:431` is the `adb-resolution` `StageFailure`, `src/fleetbuild.ts:1222`
and `:1243` are the eager `ADB()` calls, `test/logwindow.mjs:832` is the 20-line proximity
assertion, `src/doors.ts` has exactly 3 `await inner(` sites, and all twelve `/tmp/pico-render`
defaults (plus `observation.ts:818` as already run-unique) are at the cited lines.

### Strengths

- The checkpoint is checkable line by line, and it survives being checked. I verified ~40 discrete
  numeric/identity claims (commit SHAs, test counts, log counts, three receipts, digests, byte
  sizes, twelve file:line citations) and found no factual error in the shipped document.
- Evidence honesty is the document's organising principle, not a disclaimer bolted on: the class
  table at `:22-27`, the "What this checkpoint is not" section at `:377-384`, and per-row labels all
  agree with what was actually executed, and the strongest class claimed anywhere is
  `host-executed`.
- The incident record is stronger than required — digest, byte count, mechanism and wall-clock time,
  all independently reproducible from host scratch, and disclosed with "the prior bytes are not
  recoverable" rather than softened.
- The version ruling records the reviewer's caveat unwaived and names who owns the unanswered
  question (`:55-60`), instead of letting a controller ruling close a release risk.
- Gate hygiene around the final edit: the battery predates the checkpoint document, and the three
  doc-sensitive gates were re-run twice afterwards (step6 and step7), so the doc gates did see the
  final bytes. My own docsmeta run confirms it.
- The tripwire is self-tested before use (recorded `argv=devices`, exit 66, marker then deleted),
  which is what makes its later silence meaningful rather than assumed.

### Issues

#### Critical (Must Fix)

None. No over-claim of evidence and no false statement found in either shipped document.

#### Important (Should Fix)

None.

#### Minor (Nice to Have)

1. `docs/findings/CLI050_HOST_COMPLETION_CHECKPOINT.md:40` — the parenthetical on the **output**
   digest row reads "(192 published `dist/*.js` + `dist/build-receipt.json`)". The digest covers
   exactly the 192 `.js` entries (`dist/build-receipt.json` has `output.files` = 192, all `.js`;
   `dist/` holds 193 files because the receipt sits beside them and cannot hash itself). As written
   it can be read as "the digest covers 193 files". Suggest "192 published `dist/*.js`; the receipt
   is written beside them".
2. `.superpowers/sdd/2026-09-16-cli050-host-completion/task-6-report.md:305` says "the three
   surviving Low residuals from the FW1 re-review that were not description truths are disclosed in
   the checkpoint". There are **four** — re-review residuals (2), (3), (5) and (6) per
   `progress.md`'s ruling — and the checkpoint correctly says "Four Low residuals" at `:197` and
   discloses all four (`:367`, `:371`, `:374`, `:375`). The undercount is in the report only, so
   nothing shipped is wrong; worth correcting so the report and the checkpoint agree.
3. `docs/findings/CLI050_HOST_COMPLETION_CHECKPOINT.md:253-254` — "this run exists to prove that it
   [the run-gate default] does [pin every gate child]" slightly overstates what a silent tripwire
   establishes: it proves no battery child resolved `adb` from `PATH`, which is consistent with the
   pin working. The precise claim two paragraphs later (`:285`, "Nothing in the battery resolved
   `adb` from `PATH`") is exactly right, so this is framing, not a false statement.

### Assessment

**Task quality:** Approved

**Reasoning:** Every requirement of the dispatch and spec item 6 landed, and every load-bearing
claim in the two shipped documents — 38 commits, the per-task table, the 55/55 battery with a silent
tripwire, three receipts and their build identities, thirteen CHANGELOG contract items and the
re-derived AGENTS count — verifies against the tree, the logs and the receipts, with nothing native,
visual, device, cross-platform or end-to-end claimed anywhere. The three Minors are wording and a
report-only undercount; none of them changes what the checkpoint asserts.
