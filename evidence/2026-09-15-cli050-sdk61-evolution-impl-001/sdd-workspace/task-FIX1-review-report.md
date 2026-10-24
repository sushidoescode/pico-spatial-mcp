# Scoped re-review of fix wave FIX1 (8ef62e4..8729bbd, seven commits)

Reviewer: Claude Opus 5 (1M context), read-only on the worktree
`/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-sdk61-evolution-2026-09-15`. Nothing in the working
tree, index, HEAD, branch, stash or `dist/` was changed by this review (`git status --porcelain` is
empty before and after). No emulator, device, host adb server, MCP tool, `pico_doctor`, calibration,
managed-CLI store, npm-registry or main-checkout access at any point. No commit, stash or push.

**Method.** (1) The brief, the controller's dispositions (`task-FIX1-brief.md`, the ledger's last two
sections) and the findings list (`final-review-report.md`); (2) the implementer's report; (3) the
non-evidence diff `git diff 8ef62e4..8729bbd -- . ':(exclude)evidence/**'` — all 18 changed files read
in full, plus whole-file reads of `src/editorpalette.ts`, `scripts/run-gate.mjs`,
`scripts/gate-inventory.mjs` and the touched test blocks; (4) independent greps and `node -e` reads
against the tree (residual `0.13` enumeration cross-checked programmatically, receipt identities,
tarball hashes, commit trailers); (5) eight gates re-run by me with `PICO_ADB=/fixture/no/such/adb`
exported, through `npm run --silent <gate>`; (6) the evidence logs under `evidence/…/fix-wave/` and
`…/release/final/` consulted only to check the report's claims.

**Gates I re-ran (independent of the implementer's logs), all green:**

| Gate | Result |
|---|---|
| `test:lint` | 49 pass / 0 fail (matches the report's 49/49) |
| `test:docsmeta` | 26 pass / 0 fail |
| `test:distribution-adoption` | 43 pass / 0 fail |
| `test:doors` | `test/doors.mjs` "Failures: 0" incl. the three new I8 checks; `test/innerclient.mjs` 17/17 |
| `test:sdkselection` | 175 pass / 0 fail (incl. the new `install_editor_palette` case) |
| `test:observation` | 48 pass / 0 fail |
| `test:knowledge-lifecycle` | 26 pass / 0 fail |
| `test:picocli` | 157 pass / 0 fail + 22 pass / 0 fail |

`dist/` was already fresh (`verifyBuild` → `{current:true, reasons:[]}`), so no build was needed and
none was run. I deliberately did **not** re-run `test:tarball` (it packs and installs an artifact and
could reach npm) or the battery; for `[M11]` I relied on the recorded `fix-wave/test-tarball.log`
(48 checks, Failures: 0) plus a source read of `scripts/verify-tarball.mjs`.

---

## Per-finding dispositions

### Important 1 — AGENTS.md stale bootstrap sentence → **addressed**
`AGENTS.md:27-31`. The "only builds when `dist/index.js` is *absent* … stale server forever" clause is
gone; the replacement describes the identity-driven rebuild. Verified true against
`scripts/plugin-bootstrap.mjs` (`verifyDependencies(root).acceptedBy === ACCEPTED_BY.receipt &&
verifyBuild(root).current` at `:294`, build/dependency receipts at `:232-271`, no `existsSync(dist/index.js)`
gate anywhere). Outside the policy markers (the block starts at `## Managed pico-cli policy`, far below),
the paragraph's derived counts ("70 of the 97", the grep command) untouched, and
`test:distribution-adoption` — which owns both the byte-pin and the vocabulary rule — is green in my own
run (43/43).

### Important 2 — "`npm run build` never cleans `dist/`" → **addressed in both places**
Checkpoint deferred-minor "Build." bullet now ends "…orphan detection is `.js`-only." (clause deleted).
`.claude/rules/release-invariants.md:45-56` rewritten. I verified every factual claim in the rewrite
against source: `publishStaging` (`scripts/build-source.mjs:315-344`) renames `dist/`→backup, renames
staging→`dist/`, removes the backup, and on a failed rename restores the backup and names it in the
error (`:332-338`); `runGate` refuses a stale receipt for every non-`native-contract` scope including
`test:tarball` (`scripts/run-gate.mjs:165-172`); and the `[M9]`-tagged check at
`scripts/verify-tarball.mjs:614-620` really does read `dist/build-receipt.json` **out of the packed
copy** (`packedBuildIdentity(installed)`, helper at `:82-95`). No over-statement: the paragraph keeps the
honest residue that a direct verify-tarball run against an unbuilt `dist/` derives exactly that directory.

### Important 3 — "not one frame was captured or looked at" → **addressed**
`docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md:11-13`, the reviewer's wording verbatim.

### Important 4 — undisclosed `emulator-5554` defaults → **addressed as ruled (disclose only, no code change)**
Two new known-gaps rows at checkpoint `:680` and `:681`. Every citation checked against the tree and
exact: `src/perfcli.ts:74` is `const DEFAULT_PERF_DEVICE = "emulator-5554";`, `:631` is
`const device = opts.device ?? DEFAULT_PERF_DEVICE;`, `src/perftrace.ts:589` is
`request.device = device ?? "emulator-5554";`, and the `pico_perf` door (`src/doors.ts:553-560`) declares
only `{ packageName, durationSec }`. The by-design row's enumeration matches `docs/DEVICE_VERIFICATION.md`
§6 line for line. `git diff` confirms **no** change to `src/perfcli.ts` or `src/perftrace.ts` in the wave.

### Important 5 — CHANGELOG 38.0.0 section → **addressed**
`CHANGELOG.md:32-92`, inserted between the `## Unreleased` block and `## 37.0.0`. The diff is a pure
insertion — zero deleted lines in that file — so no existing entry moved, was rewritten or deleted. Opens
with the required "Unreleased entries … ship with 38.0.0 as they stand" sentence and with an explicit
evidence-boundary sentence ("fixture- and host-executed evidence, not a native, visual or cross-platform
acceptance"). Every item the brief enumerated is present, including the ones the brief listed as minimum.
The relative link `docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md` resolves (`test:docsmeta` 26/26 in
my run). `sync-metadata --check` does not key on CHANGELOG (log: 0 stale, 0 warnings; `test:docsmeta`
shells out to it and is green).

### Important 6 — residual hardcoded 0.13 consumers → **addressed (a–e)**
- **(a) migration — addressed.** `src/editorpalette.ts` read in full. The module-scope `EDITOR` constant
  and the `os.homedir()` import are gone; `resolveEditorPaletteApp` (`:57`) returns an explicit
  `editorApp` as `source:"explicit"` with no selection, otherwise resolves per call through
  `resolveOperationToolchain({ required: ["editor"], primary: "editor" }, io)` (`:61`) and derives the
  bundle root as `path.resolve(path.dirname(prepared.bin), "..", "..")` — correct for the editor
  component, whose `dir` is `["editor","Spatial Editor.app","Contents","MacOS"]`
  (`src/toolchainselection.ts:122-123`). On failure the handler returns the selection layer's own
  `{status,code,detail}` verbatim via `okJson(resolved)` — no invented shape (`isToolchainFailure` at
  `src/toolchain.ts:139`). The input description no longer claims a 0.13 default. Production call site
  `src/index.ts:356` unchanged (`deps` defaults to `{}`).
  **The test never touches a real bundle** (`test/toolchain-consumers.mjs:1017-1082`): every selection is
  an in-memory `toolchainIOFromTree`/`mixedHostIO`; the tool's `fs.existsSync(app)` check fires on
  `/sdk/6.1/editor/Spatial Editor.app`, which does not exist on this host, *before* the backup/palette
  edit/`codesign` steps — and it is exercised on **both** the `components` and the `restore` paths, which
  is the ordering that matters (`src/editorpalette.ts:88` precedes the restore branch at `:90`). The case
  also asserts the override path, the structured `unavailable/root-unavailable` shape by exact key set, a
  packer-only 6.2 install not displacing the 6.1 editor, the linux `component-unsupported-platform`
  refusal, and a source scan that no non-comment `sdk/0.13` or `os.homedir` survives. `editorpalette.ts`
  was added to the shared-selection consumer list (`:649`).
- **(b) `toolchainwatch.ts` disclosed, unchanged — addressed.** `git diff` shows the file untouched;
  known-gaps row at checkpoint `:683`.
- **(c) every residual `0.13` literal listed — addressed, and I verified completeness mechanically.** My
  own `grep -n '0\.13' src/*.ts` returns **134** matches. I parsed the checkpoint's "Residual `0.13`
  literals in `src/`" table (`:692`ff) into `file:line` pairs and diffed it against that grep:
  **0 missing**. (The 15 apparent "extras" are artifacts of my parser reading `v10.13`, `0.35,0.13` etc.
  out of the description cells.) Dispositions spot-checked: `toolchainwatch.ts:22,27` executed;
  `preflight.ts:188` `LEGACY_SDK_ADB`; `vault.ts:518` workspace label; `diagnose.ts:277` remedy text —
  all accurate.
- **(d) REVIEW.md — addressed.** Rows 1 and 8 scoped to "every consumer routed through
  `prepareOperationToolchain`/`resolveOperationToolchain` (the set `test/toolchain-consumers.mjs`
  enumerates — not every tool in the server)"; dated `## Correction (2026-09-15, final review)` appended
  at `:198` naming both tools and stating nothing else changed. The diff touches exactly those two rows
  plus the appended paragraph — nothing else in the note was rewritten.
- **(e) `.claude/rules/src-runtime.md` — addressed.** `:8-29` rewritten; the adb chain description matches
  `src/adb.ts`'s header, and the "134 matches at the fix wave" figure matches my grep.

### Important 7 — enforce the `PICO_ADB` pin in run-gate + CI → **addressed, and correctly**
- `scripts/gate-inventory.mjs:43` `export const FIXTURE_NO_ADB = "/fixture/no/such/adb"` with the
  three-incident rationale; `:46-51` `gateChildEnv(gate, env)` returns `env` **identically** for
  `native-contract` and for any caller-set `PICO_ADB` (including an explicitly empty string, since the
  test is `!== undefined`), else a fresh spread object.
- `scripts/run-gate.mjs:178` computes `childEnv` once and passes it to every `runArgv`. `process.env` is
  never written — the only construction is the spread. Caller-set always wins.
- `.github/workflows/gates.yml:16-17` workflow-level `env: PICO_ADB: /fixture/no/such/adb` with a comment
  naming the raw step it exists for. There is exactly one `env:` block in the file, so no job-level value
  shadows it.
- **Native contract untouched:** `gateChildEnv` returns the identical object, asserted by identity
  (`assert.equal(record[0].options.env, callerEnv)` and
  `assert.equal(gateChildEnv(GATES["test:vcamtransport-native"], env), env)`).
- **The unit tests are real**, driven through the injected `spawnChild` (`fakeSpawn` at
  `test/gate-inventory.mjs:292-303`, an EventEmitter stub — nothing is spawned): seven new cases at
  `:383-469` covering the literal itself, a fixture gate, an installed-artifact gate (every command), a
  caller-set value, an empty value, native-contract, `process.env` non-mutation, and the workflow-level
  block plus the lane parser. The one *modified* assertion (`:371`) is a tightening, not a loosening.
- **Inventory/workflow parsers still pass**: `validateGateInventory` and `parseWorkflowLanes` assertions
  are inside `test:lint`, green in my run (49/49), and `test:distribution-adoption`'s workflow assertions
  are green (43/43).
- **Prose truthful**: `AGENTS.md:58-63` and checkpoint `:643-654` both say run-gate applies it to
  `fixture`/`installed-artifact` children unless the caller set one, CI pins it at workflow level, and a
  direct `node --test` gets neither and must export it. That is exactly what the code does.
- **No hermeticity regression from the default**: `scripts/run-battery.mjs` spawns `npm run <gate>`, so
  every battery child inherits the new default; `test/smoke.mjs` builds its child env from scratch
  (`env: fixtureEnv`) and contains no `PICO_ADB`, so the gate-level value cannot reach the smoke server
  and smoke's own fake adb still wins — confirmed empirically by `smoke` and `test:smoke-isolation`
  passing in the fix-wave battery.

### Important 8 — partial injection leaves raw-lane doors live → **addressed**
`src/doors.ts:369-395`. `doorCallRaw` returns the injected `callRaw` when present; otherwise, if
`dependencies` was supplied at all, it **throws before any `inner()` call**, and `forwardDoor`'s catch
turns that into the door failure envelope. The mirror case (`dependencies.call` ignored beside `callRaw`)
is documented in the same comment, as ruled. `doorCall` is unchanged, so no other lane behavior moved.
Production (`src/index.ts:395`, `registerDoorTools(server)` with no dependencies) and the installed-artifact
canary both still reach `inner()` normally. The test (`test/doors.mjs:197-244`) drives **both**
`pico_look` and `pico_verify_app` on a call-only server, asserts the envelope names `callRaw`, both door
names and "call-only", asserts **zero** domain-lane calls, and separately proves `pico_emulator` on the
same server still runs through the injected `call`. Green in my own `test:doors` run.

### Important 9 — schema-optional targets → **addressed**
`src/verifyapk.ts:138` `serial: z.string()` and `src/picoclitools.ts:514` `device: z.string()` (verified
by reading those exact lines), each with the three-line comment explaining why the handler refusal stays.
Handler refusals kept and now *also* tested for the whitespace-only case
(`test/verifyapk-observation.mjs:505-509` and `:625-628`). The schema assertion uses
`inputSchema.<field>.isOptional() === false` plus description checks — which **is** F1's `watch_crash`
pattern (`test/cliobservations.mjs:463`), i.e. the shape the brief pointed at. Doors: `pico_verify_app`
already declared `serial: z.string()` (`src/doors.ts:528`) and so mirrors the inner contract; I confirmed
independently that **no door forwards `capture_record`** (`grep capture_record src/doors.ts` → nothing;
`pico_record` forwards `record_verification` at `:724`), so the brief's premise about `pico_record` was
wrong and the implementer's deviation is correct. `[M11]` sends only `preflight_env`, `pico_sdk` and
`pico_look` (`scripts/verify-tarball.mjs:460,486,563,580`) — unaffected. Every pre-existing caller already
passes the field (`test/picocli-autoinstall.mjs:1995,2050,2100`, `test/distribution-adoption.mjs:806`,
`test/doors.mjs:1019`); `test/smoke.mjs:100` only lists the name. `test:observation` and `test:picocli`
green in my runs.

### Minors
- **`src/knowledge.ts` operation name → addressed, and the extension is right.** `:1253` and `:1405` both
  pass `KNOWLEDGE_OPERATION`. Not cosmetic: `describePicoCliEnvironmentFailure(stderr, stdout, operation?)`
  (`src/picocli.ts:1011-1019`) computes
  `profilerScoped = operation === undefined || PICO_CLI_PROFILER_OPERATIONS.has(operation)`, so the third
  argument is exactly what switches the remedy off the profiler wording. Extending to `:1405` is the same
  defect at the same function; `test:knowledge-lifecycle` (26/26) and `test:picocli` green in my runs.
- **`capture_record` description → addressed, description-only.** `src/picoclitools.ts:489-494` plus the
  `status`/`media` `.describe()` texts; the handler is untouched in the diff (behavior unchanged).
- **`src/adb.ts` precedence comment → addressed.** `:31-38`; the claim that `preflight.ts` builds
  `adbInspection` the same way is true (`resolveHostToolchain({ required: ["adb"] })`, no project root).
- **LEAVE items left alone, each now with a disclosure row** — `capture_frame` naming (checkpoint `:688`),
  `[M11]`'s `/tmp/pico-render/` (`:689`), the duplicate `gates.yml:166` step (`:687`). `src/capture.ts` is
  not in the diff.

### Controller items
- **Log-tracking sentences → addressed.** Checkpoint `:203` and `:254` now say the logs are tracked,
  force-added past the `*.log` ignore in `8ef62e4`, with backtick paths (not links). Verified:
  `git log --diff-filter=A` names `8ef62e4` for both `release/battery-38.0.0.log` and
  `release/docsmeta-lockversion-RED.log`, and both are in `git ls-files`.
- **Distributable republished → addressed.** New Step 6 block at checkpoint `:460`ff lists the final
  artifact first with sha256, byte size, both build identities and a resolving relative link to the
  receipt; the F1 artifact is labeled "pre-fix-wave, superseded, byte-identical". **Verified by me
  directly:** `shasum -a 256` gives `941e402b…` / 2,158,783 bytes for F1 (unchanged; its receipt has an
  empty diff in the wave) and `c08e1a8b…` / 2,161,859 bytes for the final one, and the tracked receipt's
  own fields agree exactly (input `eb105535d137…` / 195 files → output `5d245218bf71…` / 190 files, tsc
  5.9.3, Node major 25, darwin/arm64, 48 pass / 0 fail / 0 skip, the three `limitations` lines). Nothing
  under `release/` was modified — the evidence diff is 34 additions plus the single authorized
  `sdk61-selection/REVIEW.md` modification, and no deletion.
  I also checked that the post-publish checkpoint edit cannot have invalidated the artifact: `docs/` is
  not in `package.json#files`, and nothing packed (`dist`, `scripts`, `data/sdk-compatibility`, `tools`,
  …) changed after commit `35d6f07`/`ba07103`.

---

## Evidence honesty

- **Battery.** `fix-wave/battery-38.0.0-fixwave.runner.out:203` reads
  `BATTERY FAIL 53/55 passed; 2 failed: test:claims [exit 1], test:runrevision [exit 1]` — exactly the
  report's claim, `0 skipped`, both native-contract gates really compiled. The 52/55→53/55 delta against
  F1's battery reconciles: F1's three reds were `test:claims`, `test:emulator-restart`,
  `test:spatialui-adoption`; the latter two are `PASS 37/55` and `PASS 48/55` here (they were fixed in
  `ad6d837..0fa7c71`, before this wave), and `test:runrevision` is the one new red. The report does not
  spell that reconciliation out, but nothing it says is false.
- **Tripwire.** `evidence/…/fix-wave/adb-tripwire.marker` does not exist; a `find` for any `*tripwire*`
  file under the evidence tree returns nothing. Negative evidence stands.
- **Receipts / tarballs.** Verified above, byte-for-byte.
- **Battery log copies.** `fix-wave/…` and `release/final/…` are byte-identical
  (`efe7757dea6006326d19c9cbebbbcffda35069bb1ce348b5f198d9a73a151608`), as claimed.
- **`test:claims` red is reported, not hidden** — in the report, in the checkpoint's Step 5b, and left red
  in the recorded log; `docs/claims/claims.json` is untouched in the diff.
- **No native / visual / device / cross-platform claim was added.** I grepped every added line of the
  non-evidence diff for claim vocabulary. The only `VISION-VERIFIED` hits are in
  `src/editorpalette.ts`'s description/`verify` strings, which exist verbatim at `8ef62e4` and were
  carried through unchanged (see New Minor 3). Every new doc block states its own limit.
- **Commits.** Seven, conventional subjects, and all seven carry
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. `git status --porcelain` empty; the only
  ignored-untracked artifacts are the two `.tgz`.

---

## The `test:runrevision` battery red — my own view

**Not plausibly caused by this wave; a pre-existing timing margin.** Independently established:

1. `git log --oneline 4478238..HEAD -- src/runlocks.ts test/runrevision-locks.mjs` returns **nothing** —
   no commit on the whole branch touches either, and none touches any `test/runrevision*` file.
2. The only environment delta for that gate child is `PICO_ADB`. `grep -rn PICO_ADB` across
   `src/runlocks.ts` and all four `test/runrevision-*.mjs` files returns **no hits**, so the lock path
   cannot read it. And the value is the same one F1 exported by hand, so the child's env is effectively
   identical between the two batteries.
3. The failure is a third legitimate outcome the assertion does not tolerate:
   `test/runrevision-locks.mjs:2625` asserts
   `results.every(status === "acquired" || status === "limit-exceeded")`, and the observed second result
   was `run-busy` / "shared acquisition budget expired behind a live capacity enrollment". The budget is
   `ACQUIRE_BUDGET_MS = 15_000` (`src/runlocks.ts:41`, used by `sharedDeadline` at `:1564`) inside a case
   that first writes 3 × 4,095 residue files and whose own wall time is 16–18 s.
4. F1's battery ran the same gate at position 42/55 in 117.3 s **exit 0**; the fix-wave battery ran it at
   the same position in 121.7 s with the one case at 18,051 ms; the isolated re-run log shows
   `pass 327 / fail 0`, 116.9 s.

The gate is genuinely flaky under battery load, which is itself a (now disclosed) open item — checkpoint
`:684` records it with a concrete next-sweep remedy. Not widening the budget was the right call.

---

## New issues

**Important:** none.

**Minor 1 — the I8 comment states a rule the code does not fully enforce for `{}`.** The comment at
`src/doors.ts:369-379` says "supplying `dependencies` at all means 'this server must never spawn the real
inner full-surface server'", but `registerDoorTools(server, {})` still yields `injected === null`, so the
*domain* lane falls through to `inner()` while only the raw lane refuses. No caller passes `{}` today
(`src/index.ts:395` passes nothing; `test/doors.mjs` passes `{call}` or `{call, callRaw}`;
`test/vault.mjs` passes one argument), so this is unreachable — but the comment currently over-states the
guarantee. One-line fix next sweep: either make `doorCall` refuse on a `callRaw`-less `dependencies` too,
or narrow the comment to the raw lane.

**Minor 2 — a known-gaps row heading is broader than its own body.** Checkpoint `:681` is titled
"Emulator-family tools keep the emulator default **by design**", but its body correctly says that
`logcat`/`assert_logcat`/`app_broadcast` "resolve the sole connected device" and that
`screenrecord`/`wait_for_log`/`check_crash`/`ui_dump` take a serial through the agent-loop path — neither
of which is an emulator default. The body matches `docs/DEVICE_VERIFICATION.md` §6 exactly; only the row
title generalises. Cosmetic.

**Minor 3 — `install_editor_palette`'s retained "VISION-VERIFIED" label was earned on the bundle the wave
stopped using.** The pre-existing strings at `src/editorpalette.ts:24,71,128` were carried through
unchanged (they are identical at `8ef62e4`, so this is not a new claim and not a wave defect), but the
look that earned them was of the hardcoded 0.13 bundle. Under this repo's evidence rule the honest
next-sweep move is to date/scope that label (e.g. "vision-verified on the 0.13 bundle, 2026-07") rather
than let it read as verified for the selected bundle. Not blocking; no new evidence was claimed.

**Minor 4 — the implementer's report cites pre-`8729bbd` checkpoint line numbers.** It cites the
known-gaps rows as `:606-607`, `:608`, `:609`, `:617` and the rule text as `:569`; in the final tree they
are `:680`, `:682`, `:683`, `:685` and `:643` (commit `8729bbd` inserted the Step 5b and Step 6 blocks
above them). Every cited row exists and its content is exactly as described — only the numbers drifted.
Report hygiene, not a tree defect.

---

## Regressions

None found. No assertion was loosened, no gate skipped, no count changed without derivation:

- the single modified assertion (`test/gate-inventory.mjs:371`) is a tightening;
- every other test change is purely additive (`+49` doors, `+94` gate-inventory, `+69`
  toolchain-consumers, `+33` verifyapk-observation, no deletions of test cases);
- the published counts (255 / 252 / 18) are untouched — `sync-metadata --check` reports 0 stale sites and
  0 warnings, `test:docsmeta` and `test:distribution-adoption` are green in my own runs;
- the two schema tightenings break no existing caller (all verified);
- the I8 refusal cannot reach production or the installed canary (both use the un-injected path);
- the I7 default cannot reach a fixture that names its own adb (`test/emulator.mjs:99`,
  `test/doors.mjs:209,260`) nor smoke's from-scratch fixture env.

---

## Verdict

**clean.**

Every Important (1–9) and every FIX-marked Minor is implemented exactly as the controller ruled — not
more, not less. The two DISCLOSE-ONLY items (I4, I6b) changed no code and their disclosures are accurate
and complete, including I6c, whose completeness I confirmed mechanically against my own grep (134/134
literals listed, 0 missing). The evidence claims — battery 53/55 with the two named reds, the absent
tripwire marker, both tarball hashes and byte counts, the new receipt's identities, the byte-identical
battery-log copies, F1's untouched artifact — all match the tree and the logs. The `test:runrevision` red
is, on my own independent check, a pre-existing timing margin that no commit on this branch could have
caused, and it is disclosed rather than papered over.

Nothing requires a fix round. The four new Minors above (the `{}` comment over-statement in
`src/doors.ts`, the known-gaps row title at checkpoint `:681`, the stale-scope `VISION-VERIFIED` label in
`src/editorpalette.ts`, and the drifted line numbers in `task-FIX1-report.md`) are next-sweep or
no-action items and none of them makes a shipped document false.

**Exact list for a fix round: none.**
