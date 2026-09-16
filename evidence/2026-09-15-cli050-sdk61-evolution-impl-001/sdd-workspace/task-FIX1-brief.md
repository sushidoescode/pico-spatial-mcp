# Task FIX1 — final-review fix wave (one wave, complete list)

You are the implementer for the ONE fix wave that follows the final whole-branch review of branch
`cli050-sdk61-evolution-2026-09-15`. Work ONLY in the integration worktree
`/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-sdk61-evolution-2026-09-15` (branch already checked
out; BASE = commit 8ef62e4). Never `cd` to `/Users/sushantsrikrish/PICO-MCP` itself, never touch `main`,
never push, never rewrite history. You are the only writer in this worktree for the duration of the task.

## Read first (in this order)
1. `.superpowers/sdd/2026-09-15-cli050-sdk61-evolution/global-constraints.md` — binding user constraints.
2. The ledger `.superpowers/sdd/2026-09-15-cli050-sdk61-evolution/progress.md`: read its LAST TWO sections
   ("Post-final-review controller plan" and "Final whole-branch review → fix wave FIX1") — they hold the
   rulings you implement. Do NOT edit the ledger (controller-owned); you write only your report.
3. `.superpowers/sdd/2026-09-15-cli050-sdk61-evolution/final-review-report.md` — the complete findings list.
   Every Important item and every Minor item is dispositioned below; do not re-triage.
4. `AGENTS.md` (repo contract; note the byte-pinned policy block and the vocabulary rule enforced by
   `test/distribution-adoption.mjs` — read that test's `contradictoryManagedPolicyPatterns` before writing
   any prose in README/AGENTS/TESTERS/SKILLS/GETTING_STARTED/docs/HOSTS/CHANGELOG).
5. `docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md`, `docs/findings/CLI050_CAPABILITY_MATRIX.md`,
   `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/sdk61-selection/REVIEW.md`.
6. `.superpowers/sdd/2026-09-15-cli050-sdk61-evolution/task-F1-brief.md` and `task-F1-report.md` — how the
   checkpoint, battery and distributable were produced (you repeat the battery and the publish).

## Hard rules for this task
- Every direct test invocation (`node --test …`, `npm run test:*`, `npm run smoke`) you run BEFORE the
  run-gate default (item I7 below) exists MUST have `PICO_ADB=/fixture/no/such/adb` exported in the process
  environment. After I7 is implemented and its unit test passes, gate runs through `scripts/run-gate.mjs` /
  `scripts/run-battery.mjs` carry the default themselves; direct `node --test` runs still need the export.
- Never touch the emulator (`emulator-5554`), any physical device, the host adb server, the managed CLI
  store, npm registry, `pico_doctor`, any MCP tool, `pico-cli setup`, global PATH/CLI, or
  `/Users/sushantsrikrish/AndroidStudioProjects/rocketsim-mission-replay`. No calibration. No emulator
  restart. No global logcat clear.
- Preserve evidence bytes: do not modify or delete anything already under
  `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/` except the ONE narrative note named in I6 (visible,
  dated correction). Write every new log under the FRESH directory
  `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/fix-wave/` (create it) and the new distributable under
  `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/final/` (create it). F1's
  `release/pico-spatial-mcp-38.0.0.tgz` and its receipt stay byte-identical.
- `npm run build` before any test that imports `dist/` (all of them; `run-gate` refuses stale `dist/`).
- Label evidence honestly: everything you produce is fixture / source-derived / host-executed-hermetic;
  nothing here is native, visual, device, cross-platform or end-to-end. Do not claim otherwise anywhere.
- Commits: small logical groups, conventional subjects (`fix:`, `docs:`, `test:`, `chore:`), and EVERY commit
  message ends with the trailer line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Report failures faithfully. If a gate is red, say so with the output; do not weaken a gate to make it pass.
  `test:claims` is EXPECTED red on this host (host-state snapshot drift; ruled, documented in the checkpoint) —
  report it as red, do not regenerate the snapshot (that would publish the paused Mission Replay app).

## Dispositions (implement exactly these; numbering follows the review report)

### Important 1 — AGENTS.md:29 stale bootstrap sentence → FIX
Replace the clause "`scripts/plugin-bootstrap.mjs` only builds when `dist/index.js` is *absent*, so a host
serves a stale server forever across restarts" with one true sentence describing the identity-driven rebuild
(source + dependency identity; see `scripts/plugin-bootstrap.mjs` and the checkpoint's R2 row). Stay outside
the policy markers, use no policy vocabulary, keep the paragraph's derived counts intact.

### Important 2 — "`npm run build` never cleans `dist/`" → FIX in both places
Delete the false clause from the checkpoint's deferred-minor list (~line 582) and rewrite the paragraph in
`.claude/rules/release-invariants.md` (~line 45) to describe `publishStaging`'s staging→backup→rename
publication (orphans removed by the tree swap) and verify-tarball's source-bound payload.

### Important 3 — CHECKPOINT.md:11 "not one frame was captured or looked at" → FIX
Use the reviewer's wording: "no frame was captured as evidence or looked at; the only frames produced were
the accidental RED-run captures recorded under Negative evidence, neither inspected nor retained."

### Important 4 — undisclosed emulator-5554 defaults → DISCLOSE ONLY (no code change)
Add row(s) to the checkpoint's "Known gaps carried forward" table: `perf_diagnose` (and the `pico_perf`
door) at `src/perfcli.ts:74,631` and `perf_trace record` at `src/perftrace.ts:589` still default `device` to
`emulator-5554`; plus the emulator-family tools that keep the default BY DESIGN (enumerate from
`docs/DEVICE_VERIFICATION.md`; cite it). State that applying the refusal is a further contract break deferred
to the next surface sweep. Do not change perf behavior.

### Important 5 — CHANGELOG.md 38.0.0 section → FIX
Add `## 38.0.0 — 2026-09-15` directly BELOW the existing `## Unreleased` block and ABOVE `## 37.0.0`. Do not
move, rewrite or delete existing entries; open the section with one sentence saying the Unreleased entries
above accumulated on main after 37.0.0 and ship with 38.0.0 as they stand. List every compatibility-affecting
change from the checkpoint's "Why 38.0.0" section (at least: version-dependent knowledge argv; `watch_crash`
`watchedSec` observed-not-requested + coverage/assessment fields + required `device`; door `isError`
forwarding; `verify_pico_apk` result shape + required `serial`; `capture_frame`/`capture_record` explicit
targets and run-unique outputs; `scaffold` refusal; fail-closed explicit `PICO_ADB`; the source-bound build
script; `--publish` add-only semantics; `perf_diagnose` → `perf live run` dispatch) and link the checkpoint
with a relative link that resolves (`test/docsmeta.mjs` checks it). No policy vocabulary. Run any
`sync:meta`/metadata check the repo has to be sure CHANGELOG is not version-keyed by a gate
(`npm run sync:meta -- --check` or whatever `package.json` defines).

### Important 6 — residual hardcoded 0.13 consumers → PARTIAL FIX + DISCLOSURE
(a) Migrate `src/editorpalette.ts`: replace the module-scope `EDITOR` constant with a per-call resolution
through `resolveOperationToolchain({ required: ["editor"], primary: "editor" })` (see
`src/toolchainselection.ts`, `src/toolchain.ts` and how `src/editor.ts` selects the editor component).
An explicit `editorApp` argument is honoured as an explicit path (wins over selection, exactly as an
explicit override does elsewhere). When no editor is selected, return the structured `unavailable/*` error
the selection layer produces (do not invent a new error shape). Update the input description ("default the
SDK 0.13 location" is false). Add a test (prefer extending `test/toolchain-consumers.mjs`) that proves
selection WITHOUT touching a real editor bundle: with a fixture home that selects a version whose editor app
path does not exist, the tool's error names the SELECTED path; with `editorApp` pointing at a nonexistent
override, the error names the override; with no editor selectable, the structured unavailable error is
returned. Never call the tool against a real `Spatial Editor.app` — it modifies and re-signs bundles.
(b) `src/toolchainwatch.ts` (`check_toolchain_updates`) stays as is — DISCLOSE it.
(c) `grep -n '0\.13' src/*.ts` — list EVERY residual literal (path or version) in the checkpoint's open
items with a one-line disposition each (by design / informational / to migrate next sweep).
(d) `evidence/…/sdk61-selection/REVIEW.md` rows ~76 and ~84: scope the claim to "every consumer routed
through `prepareOperationToolchain`/`resolveOperationToolchain` (the set `test/toolchain-consumers.mjs`
enumerates)" and append a dated "Correction (2026-09-15, final review)" paragraph explaining the edit and
naming the two tools that were outside that set. Do not otherwise rewrite the note.
(e) Refresh `.claude/rules/src-runtime.md` (~line 10, "roughly 32 sites") to the current state: selection
via `src/toolchainselection.ts`, the residual literals from (c).

### Important 7 — enforce the PICO_ADB pin in run-gate + CI → FIX
In `scripts/gate-inventory.mjs` export a constant (e.g. `FIXTURE_NO_ADB = "/fixture/no/such/adb"` — the
exact literal every pinned run this session used) with a comment explaining why (three RED-phase
incidents; fail-closed explicit override in `src/adb.ts`). In `scripts/run-gate.mjs` `runGate`: for gates
whose scope is `fixture` or `installed-artifact`, when the caller's env has no `PICO_ADB`, spawn the child
with `PICO_ADB = FIXTURE_NO_ADB`; a caller-set value ALWAYS wins; `native-contract` gates get no default.
Do not mutate `process.env`; build the child env. Unit tests (extend `test/gate-inventory.mjs` or the
existing run-gate test file, using the injectable `spawnChild`): default applied for a fixture gate; caller
value preserved; native-contract untouched. `.github/workflows/gates.yml`: add a workflow-level `env:` with
`PICO_ADB: /fixture/no/such/adb` (covers the one raw `node --test test/homeenvironmenthost.mjs` step) and
make sure `validateGateInventory`/the workflow parser in `test/gate-inventory.mjs` and
`test/distribution-adoption.mjs` still pass. Update the "rule this leaves behind" text in the checkpoint
and the matching AGENTS.md sentence(s): the pin is now applied by run-gate for fixture/installed-artifact
gates and by CI's workflow env; direct `node --test` runs must still export it.

### Important 8 — partial injection leaves raw-lane doors live → FIX
`src/doors.ts` `registerDoorTools`: when `dependencies` is supplied WITHOUT `callRaw`, `doorCallRaw` must
reject with a fixture error (message naming the missing `callRaw` seam and the two raw-lane doors) BEFORE
any `inner()` call, so a call-only fixture server can never spawn the real inner server. Document the
mirror case (C5 ledger minor: `dependencies.call` is ignored when `callRaw` is present) in the same
comment. Test in `test/doors.mjs`: on a call-only server, `pico_look` (and `pico_verify_app`) return the
door failure envelope whose error names the seam; keep the pin exported for that file's run.

### Important 9 — schema-optional targets → FIX (two one-line schema edits + tests)
`src/verifyapk.ts:135` `serial: z.string()` (required) and `src/picoclitools.ts:506` `device: z.string()`
(required); keep the "REQUIRED … no default" prose consistent; keep the handlers' own refusals as defense
in depth for programmatic callers. Adjust the existing refusal tests to the SDK validation-error shape the
way F1 did for `watch_crash` (see commits ad6d837..0fa7c71 and `test/cliobservations.mjs`,
`test/verifyapk-observation.mjs`, `test/picocli.mjs`). Check the doors that forward to these tools
(`pico_verify_app`, `pico_record` in `src/doors.ts`) and make their input schemas mirror the inner contract;
`test/doors.mjs` and the tarball canary `[M11]` (`scripts/verify-tarball.mjs`) must still pass — read what
the canary sends before changing anything.

### Minors
- `src/knowledge.ts:1251`: pass `KNOWLEDGE_OPERATION` to `describePicoCliEnvironmentFailure`; adjust any
  test that asserts the wording. → FIX
- `capture_record` (`src/picoclitools.ts` ~578): description-only clarification — `status` reports the
  recording call, `media` is the validation verdict, `unvalidated` means the container was not inspected
  (over budget/unreadable). No behavior change. → FIX (description)
- `src/adb.ts`: document beside the precedence comment that the bundled adb resolves from the host tools
  root (no `androidProjectRoot`), so a project's `spatial.tools.dir` selects the packer but not adb, and
  that `preflight.ts`'s `adbInspection` agrees. → FIX (comment)
- `src/capture.ts:18` naming → LEAVE. `scripts/verify-tarball.mjs` [M11] `/tmp/pico-render/` → LEAVE.
  `gates.yml:166` duplicate → LEAVE (already disclosed).

### Controller items (folded in)
- Checkpoint sentences ~171-172 and ~221-222 say the RED log / battery log are "untracked because the
  repository gitignores `*.log`": they are now tracked — commit 8ef62e4 force-added the checkpoint's text
  evidence past the ignore (as the audit evidence directory does). Reword; keep backtick paths (not links)
  unless the target exists in the tree at gate time.
- After the wave is green (below), republish the distributable from the FINAL tree to the fresh path
  `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/final/pico-spatial-mcp-38.0.0.tgz` with the
  same non-replacing publish route F1 used (`node scripts/verify-tarball.mjs --publish <abs path>`; see the
  F1 report). Track its receipt (`git add` the `.receipt.json`; the `.tgz` stays untracked). Update the
  checkpoint's distributable section: the F1 artifact (sha256
  `941e402bb2c234c444e31c62c9bc9dc2c69055ac3aeee48c960e870e100f36d6`, build input
  `e51cb8f1…`) is labeled "pre-fix-wave, superseded, byte-identical"; the final artifact's sha256, byte
  size, build input/output identities and receipt path are listed. Do not touch the F1 files.

## Verification (in this order; keep every log under evidence/…/fix-wave/)
1. `npm run build` (log `build.log`).
2. Targeted suites WITH the export, one log each (gate names per `scripts/gate-inventory.mjs`; there is no
   `test:public-docs` script — `test/public-docs.mjs` runs inside `test:docsmeta`, `test/gate-inventory.mjs`
   and `test/run-battery.mjs` inside `test:lint`, `test/toolchain-consumers.mjs` inside `test:sdkselection`,
   `test/cliobservations.mjs` inside `test:picocli`, `test/verifyapk-observation.mjs` inside `test:observation`):
   `test:lint`, `test:docsmeta`, `test:distribution-adoption`, `test:prompts`, `test:picocli`,
   `test:observation`, `test:doors`, `test:sdkselection`, `test:tarball`, `test:knowledge-lifecycle`,
   `test:buildfreshness`, `test:plugin-bootstrap-freshness`. Every one must be green.
3. Full battery WITHOUT the export, proving the enforced default: prepend a tripwire directory to PATH
   containing an executable `adb` that appends its argv to `fix-wave/adb-tripwire.marker` and exits 66, then
   `node scripts/run-battery.mjs` (log `battery-38.0.0-fixwave.log`, copy also to
   `release/final/battery-38.0.0-fixwave.log`). Afterwards record whether the marker file exists (it must
   not; if it does, include its contents verbatim in your report — that is a finding, not something to hide).
   `test:claims` red is expected; any OTHER red must be investigated and fixed or reported.
4. Republish the distributable (above); `node -e` read the new receipt and quote its sha256/bytes/build
   identities in the report; confirm F1's tarball sha256 is unchanged (`shasum -a 256`).
5. `git status` must be clean except the untracked `.tgz`; list your commits (`git log --oneline 8ef62e4..HEAD`).

## Report
Write `.superpowers/sdd/2026-09-15-cli050-sdk61-evolution/task-FIX1-report.md`: per-item disposition with
file:line and commit; every command you ran with its exit status and log path; the tripwire result; the
battery summary (gate counts, reds by name); the new receipt identities; anything NOT done and why; any
deviation from this brief with the reason. Then return the same content as your final message.
