# Task FIX1 — final-review fix wave: report

**Status: DONE, with two disclosures that need the controller's eye** (a `test:runrevision` timing
red in the battery that is green in isolation, and one deviation from the brief's premise about
which doors forward `capture_record`). Every disposition in the brief is implemented; nothing was
left out. BASE `8ef62e4` → HEAD `8729bbd`, seven commits, every message ending with the
`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer (verified with
`git log --format='%(trailers:key=Co-Authored-By)'`). Nothing pushed; no history rewritten; no
`git stash` of any kind; `main` and the main checkout untouched.

No emulator, device, host adb server, MCP tool, `pico_doctor`, calibration, managed CLI store,
npm registry, global CLI/PATH or `rocketsim-mission-replay` operation at any point. No logcat
clear. Everything produced here is fixture / source-derived / host-executed-hermetic; nothing is
native, visual, device, cross-platform or end-to-end evidence.

## Commits (`git log --oneline 8ef62e4..HEAD`)

| Commit | Subject |
|---|---|
| `35d6f07` | fix: apply the PICO_ADB hermeticity barrier in run-gate and CI |
| `7297f68` | fix: refuse raw-lane doors on a call-only fixture server |
| `9b384bb` | fix: require the observation target in the verify_pico_apk and capture_record schemas |
| `48aebc9` | fix: select the editor palette bundle through the toolchain selection |
| `ba07103` | fix: name the knowledge operation in its environment remedy; document adb's host-root scope |
| `1a22709` | docs: make the governing docs, checkpoint and changelog true at 38.0.0 |
| `8729bbd` | chore: record the fix-wave battery, targeted-suite logs and the republished 38.0.0 distributable |

`git status` after the last commit: clean. The only untracked files are the two ignored tarballs
(`git status --short --ignored` shows `!! …/release/pico-spatial-mcp-38.0.0.tgz` and
`!! …/release/final/pico-spatial-mcp-38.0.0.tgz`).

## Per-item dispositions

### Important 1 — AGENTS.md stale bootstrap sentence → FIXED (`1a22709`)
`AGENTS.md:27-31`. The clause "only builds when `dist/index.js` is *absent*, so a host serves a
stale server forever across restarts" is replaced by: the plugin form closes the same trap by
itself — `scripts/plugin-bootstrap.mjs` decides from its build and dependency receipts (the
identity of the sources and the lockfile the output was built from, not whether `dist/index.js`
happens to exist) and rebuilds a host plugin cache whose source moved before it starts the server.
Outside the policy markers; no policy vocabulary (checked against
`contradictoryManagedPolicyPatterns` and the alternate-claims tokens); the paragraph's derived
counts (70 of 97, the grep command) untouched. `test:distribution-adoption` 43/43.

### Important 2 — "`npm run build` never cleans `dist/`" → FIXED in both places (`1a22709`)
- `docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md` deferred-minor "Build." bullet: the false
  clause deleted (now "…orphan detection is `.js`-only.").
- `.claude/rules/release-invariants.md:45-56`: rewritten to describe `publishStaging`
  (`scripts/build-source.mjs:315`): staging tree → previous `dist/` renamed to a backup → staging
  renamed to `dist/` → backup removed (a failed rename restores the backup and names it), so an
  orphan disappears with the tree it lived in; plus the receipt binding (`dist/build-receipt.json`,
  `run-gate`'s staleness refusal for every fixture/installed-artifact gate including
  `test:tarball`, and verify-tarball's `[M9]` reading the receipt out of the packed copy), with
  the honest residue that a direct verify-tarball run against an unbuilt `dist/` derives exactly
  what that directory holds.

### Important 3 — "not one frame was captured or looked at" → FIXED (`1a22709`)
`docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md:11-12`, the reviewer's wording verbatim: "no
frame was captured as evidence or looked at; the only frames produced were the accidental RED-run
captures recorded under Negative evidence, neither inspected nor retained".

### Important 4 — undisclosed `emulator-5554` defaults → DISCLOSED, no code change (`1a22709`)
Known-gaps table, checkpoint `:606-607`: a row for `perf_diagnose` / `pico_perf` and `perf_trace
record` (`src/perfcli.ts:74` `DEFAULT_PERF_DEVICE`, `:631` `opts.device ?? DEFAULT_PERF_DEVICE`;
`src/perftrace.ts:589` `device ?? "emulator-5554"`; the `pico_perf` door takes only
`packageName`/`durationSec`), stating the refusal is a further contract break deferred to the next
surface sweep; and a row for the emulator-family tools that keep the default by design, enumerated
from and citing `docs/DEVICE_VERIFICATION.md` §6 (`verify_baseline`, `verify_visual`,
`capture_canonical`; `capture_canonical`/`pico_look`; `logcat`, `assert_logcat`, `app_broadcast`,
basic adb tools; `screenrecord`, `wait_for_log`, `check_crash`, `ui_dump`). Perf behavior untouched.

### Important 5 — CHANGELOG 38.0.0 section → FIXED (`1a22709`)
`CHANGELOG.md:32-93`: `## 38.0.0 — 2026-09-15` directly below the `## Unreleased` block and above
`## 37.0.0`, opening with the sentence that the Unreleased entries above accumulated on main after
37.0.0 and ship with 38.0.0 as they stand; no existing entry moved, rewritten or deleted. Lists:
version-dependent knowledge argv (+ the knowledge remedy wording); `watch_crash` `watchedSec`
observed-not-requested + coverage/assessment + required `device` (schema); `perf_diagnose` → `perf
live run` dispatch; door `isError` forwarding + single-flight + the call-only refusal;
`verify_pico_apk` result shape + required `serial` (schema) + no logcat clear / no foreign stop;
`capture_frame`/`capture_record` explicit targets + run-unique outputs (+ the status/media
clarification); `scaffold` refusal; fail-closed explicit `PICO_ADB`; component-valid selection
(incl. `install_editor_palette`); the source-bound build script (+ the run-gate `PICO_ADB`
default); `--publish` add-only; the shipped payload. Relative link
`docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md` resolves (`test:docsmeta`: "all 169 relative
markdown links resolve"). No policy vocabulary. `node scripts/sync-metadata.mjs --check`: 0 stale
sites, 0 warnings — CHANGELOG is not version-keyed by any gate (`grep CHANGELOG
scripts/sync-metadata.mjs test/docsmeta.mjs` → nothing).

### Important 6 — residual hardcoded 0.13 consumers → PARTIAL FIX + DISCLOSURE
- **(a) `src/editorpalette.ts` migrated (`48aebc9`).** The module-scope `EDITOR` constant and the
  `os.homedir()` import are gone. `resolveEditorPaletteApp(editorApp, io)` (`:57`) honours an
  explicit `editorApp` as an explicit path (wins over selection), otherwise resolves per call
  through `resolveOperationToolchain({ required: ["editor"], primary: "editor" }, io)` (`:28`,
  `:61`) — the same selection `src/editor.ts` runs — and derives the bundle root from `bin`
  (`…/Contents/MacOS/Spatial Editor` → `…/Spatial Editor.app`). When nothing is selectable the
  handler returns the selection layer's own `{status:"unavailable", code, detail}` verbatim
  (`okJson(resolved)`), no new shape. Every result discloses `editorApp`, `editorAppSource`
  (`explicit`/`selected`) and `toolchainProvenance(...)`. Input description rewritten (the
  "default the SDK 0.13 location" claim is gone). `registerEditorPaletteTools(server, deps = {})`
  takes an optional `{ io }` for tests; `src/index.ts:356`'s call is unchanged.
  Test `test/toolchain-consumers.mjs:1017` ("S6 matrix (fix wave): install_editor_palette …"),
  in-memory tree only: a host carrying both 0.13 and 6.1 editor bundles selects 6.1 and the tool's
  real-filesystem existence check fails naming `/sdk/6.1/editor/Spatial Editor.app` (for both the
  `components` and the `restore` paths, before any backup/edit/codesign; provenance disclosed;
  never `0.13`); `editorApp: "/opt/custom/Spatial Editor.app"` fails naming the override with
  `editorAppSource: "explicit"` and no selection provenance; an empty root returns exactly
  `{code:"unavailable/root-unavailable", detail, status}`; a newer packer-only 6.2 install does not
  displace the 6.1 editor selection; linux returns `unavailable/component-unsupported-platform`;
  and a source scan asserts no non-comment `sdk/0.13` or `os.homedir` remains. `editorpalette.ts`
  was also added to the "packer consumers import the shared selection" list (`:649`). No real
  `Spatial Editor.app` was selected, opened, modified or re-signed.
- **(b) `src/toolchainwatch.ts` — DISCLOSED, unchanged.** Known-gaps row (checkpoint `:609`) and
  the REVIEW.md correction name it: `check_toolchain_updates` reads `~/Library/PICO/sdk/0.13/
  emulator/package.xml` and the 0.13 editor `version` (`:22,27`), an informational reporter that
  selects and launches nothing; next surface sweep.
- **(c) every residual `0.13` literal listed.** Checkpoint `:617` "Residual `0.13` literals in
  `src/`": `grep -n '0\.13' src/*.ts` at the fix wave = **134 matches**, every file:line enumerated
  in a table with one disposition each (migrate next sweep / by design / informational / not a
  version), generated by a script over the post-edit tree and cross-checked to 134. Executed
  paths: only `toolchainwatch.ts:22,27`. Retained by design: `preflight.ts:188` `LEGACY_SDK_ADB`
  (last candidate, pinned by S6), `vault.ts:518` default vault workspace label. Remedy text:
  `diagnose.ts:277` — verified still true of `scripts/restart-emulator.sh` (`DEFAULT_EMU_ROOT=
  ~/Library/PICO/sdk/0.13/emulator`, AVD `PICO_0.13`). Numeric coincidences (7): `missiontable.ts`
  `-0.13f`, `setdressing.ts` colours, `splatanalyze.ts:331` `Color4(0.13f…)`, `web3d.ts` radius,
  `webbridge.ts` `v10.13`. The rest are `'0.13'` version-label examples and `0.13.3` provenance
  references in descriptions/comments.
- **(d) `evidence/…/sdk61-selection/REVIEW.md`** rows 1 (`:76`) and 8 (`:84`) scoped to "every
  consumer routed through `prepareOperationToolchain`/`resolveOperationToolchain` (the set
  `test/toolchain-consumers.mjs` enumerates — not every tool in the server)"; a dated
  "## Correction (2026-09-15, final review)" appended at `:198` naming `install_editor_palette`
  (migrated) and `check_toolchain_updates` (still reads 0.13) and stating nothing else in the note
  changed. The exact test names in the rows were not altered (they are the evidence references).
- **(e) `.claude/rules/src-runtime.md:8-29`** refreshed: component-valid selection via
  `src/toolchainselection.ts` + `resolveOperationToolchain`/`prepareOperationToolchain`, the adb
  chain, and the residual literals from (c) with pointers to the checkpoint table.

### Important 7 — enforce the `PICO_ADB` pin in run-gate + CI → FIXED (`35d6f07`)
- `scripts/gate-inventory.mjs:43` `export const FIXTURE_NO_ADB = "/fixture/no/such/adb"` with the
  why (three RED-phase incidents; `src/adb.ts` fails closed on an explicit override; fixtures name
  their own adb; native-contract never resolves adb) and `:46` `gateChildEnv(gate, env)`: returns
  `env` untouched for `native-contract` or when `env.PICO_ADB !== undefined`, else a fresh
  `{ ...env, PICO_ADB: FIXTURE_NO_ADB }` — never mutates.
- `scripts/run-gate.mjs:178` `runGate` builds `childEnv = gateChildEnv(gate, env)` once and passes
  it to every `runArgv`; `process.env` is never written; header comment documents it.
- `.github/workflows/gates.yml:11-17` workflow-level `env: PICO_ADB: /fixture/no/such/adb` with a
  comment naming the one raw `node --test test/homeenvironmenthost.mjs` step it covers.
- `test/gate-inventory.mjs`: the existing `test:eye` env assertion now expects the applied default;
  seven new cases (`:393-…`): the literal is exact and names no file; fixture gate gets the default
  and the caller's object is not written; installed-artifact gate (every command) gets it; a
  caller-set value wins and an explicitly EMPTY value is also kept; native-contract child env is
  the very same object with no `PICO_ADB`; `process.env` untouched + `gateChildEnv` identity
  semantics; `gates.yml` carries the literal at workflow level before `jobs:`, the raw step is
  still raw, and `parseWorkflowLanes` still sees exactly `picocli-windows`, `gates`,
  `vcam-native`. 38/38 → 49/49 in `test:lint`. `validateGateInventory` and
  `test:distribution-adoption`'s workflow assertions pass.
- Prose: checkpoint "The rule this leaves behind — enforced since the fix wave" (`:569`) and the
  matching AGENTS.md sentence (`:57-63`): applied by run-gate for fixture/installed-artifact
  children and by CI's workflow env; a direct `node --test` still must export it.
- Order of operations as the brief required: every direct test invocation before this landed ran
  with `PICO_ADB=/fixture/no/such/adb` exported; the unit test passed (38/38, `gate-inventory-i7.log`)
  before any gate was run through the new default.

### Important 8 — partial injection leaves raw-lane doors live → FIXED (`7297f68`)
`src/doors.ts:369-395`: `doorCallRaw` returns the injected `callRaw` when present; when
`dependencies` was supplied without `callRaw` it **throws** a fixture error before any `inner()`
call — "registerDoorTools was given a call-only fixture (dependencies.call without
dependencies.callRaw): the raw-lane doors pico_look and pico_verify_app forward the inner
CallToolResult verbatim and have no seam to forward through, so this call is refused rather than
spawning the real inner full-surface server. Inject dependencies.callRaw…" — which `forwardDoor`
turns into the door failure envelope (`{status:"error", error, fix}`). The mirror case
(`dependencies.call` ignored when `callRaw` is present; the domain lane is derived from `callRaw`
with the production decoder) is documented in the same comment. Test block `test/doors.mjs:197`
("partial injection (fix wave)"): on a call-only server, under a `PICO_ADB` pinned to an exit-1
stub, `pico_look` and `pico_verify_app` return the door failure envelope whose `error` names
`callRaw`, both doors and "call-only", with zero domain-lane calls; and `pico_emulator` on the
same server still runs through the injected `call`. `test:doors` green (3 new `ok` lines).
Residual, disclosed not changed (checkpoint `:608`): nine doors (`pico_scan_world`, `pico_place`,
`pico_measure`, `pico_perf`, `pico_sdk`, `pico_doctor`, `pico_capabilities`, `pico_fix`,
`pico_next`) call `inner()` directly and bypass the seam entirely — pre-existing, outside the
reviewed raw-lane finding.

### Important 9 — schema-optional targets → FIXED (`9b384bb`)
- `src/verifyapk.ts:138` `serial: z.string()` (required) with F1's three-line comment; handler
  refusal for empty/whitespace kept.
- `src/picoclitools.ts:514` `device: z.string()` (required) for `capture_record`; handler refusal
  kept.
- Tests follow F1's `watch_crash` pattern: `test/verifyapk-observation.mjs` "the serial is
  REQUIRED" case gains the whitespace-only refusal (no device command runs) and
  `metadata.verify_pico_apk.inputSchema.serial.isOptional() === false` plus description checks
  (`:521`); the `capture_record` case gains the whitespace refusal (no `picoCli` provenance) and
  `metadata.capture_record.inputSchema.device.isOptional() === false` (`:632`). `test:observation`
  48/48; `test:picocli` green (the description assertions at `test/picocli.mjs:166-171` still
  pass); `test:distribution-adoption` 43/43 (its stdio client sends `device: "fixture-record-0001"`).
  Every existing caller in `test/` (`picocli-autoinstall.mjs` ×3, `distribution-adoption.mjs`,
  `smoke.mjs` — which only lists the tool) already passed the target.
- Doors: `pico_verify_app` already declared `serial: z.string()` and so mirrors the inner contract
  (`test/doors.mjs` C5 lanes pass `serial`). **Deviation from the brief's premise:** `pico_record`
  is DOOR 13 and forwards `record_verification`, not `capture_record`; no door forwards
  `capture_record` or `watch_crash` (`grep capture_record src/doors.ts` → nothing), so there was
  nothing to mirror for it. `[M11]` (read before changing anything) sends only `pico_sdk` and
  `pico_look` to an un-injected installed server — unaffected; `test:tarball` green (48 checks).

### Minors
- `src/knowledge.ts:1253` passes `KNOWLEDGE_OPERATION` to `describePicoCliEnvironmentFailure`
  (`ba07103`). **Small extension:** the second call site at `:1405` (the child-startup environment
  path) had the same omission and now passes it too — the reviewer named only the first line, but
  the wording defect is identical. Tests asserting the wording: `test/knowledge-lifecycle.mjs:1329`
  (`/PICO_HOME/`, `/absolute PICO SDK root/`, no `pico-cli setup`) still passes — both are in the
  non-profiler variant; `test/picocli.mjs:463-469` ("profiler payload only for perf operations")
  and `test/cliobservations.mjs:413` unchanged and green. No test asserted the old knowledge wording.
- `capture_record` description clarification (`9b384bb`, `src/picoclitools.ts:489-494` and the
  `status`/`media` `.describe()` texts): `status` grades the recording CALL; `media` is the separate
  validation verdict; `unvalidated` = the container was NOT inspected (over budget / unreadable),
  never a successful decode. No behavior change (the handler is untouched); the five strings
  `test/picocli.mjs` requires are all still present.
- `src/adb.ts:31-38` (`ba07103`): beside the precedence comment — the bundled candidate resolves
  from the HOST tools root (`resolveRootCandidate({}, io)`, no `androidProjectRoot`), so a project's
  `spatial.tools.dir` selects the packer but never adb, and `src/preflight.ts:101` builds
  `adbInspection` the same way (`resolveHostToolchain({ required: ["adb"] })`), so the doctor row
  and every consumer agree.
- LEAVE items left as ruled: `src/capture.ts:18` naming, `[M11]` `/tmp/pico-render/`,
  `gates.yml:166` duplicate. Each now has a disclosure row in the checkpoint's known-gaps table
  (the raw-step row also notes the duplication and that the new workflow env covers it).

### Controller items
- Checkpoint sentences about the RED log (`:203`) and the battery log (`:254`) now say the logs are
  tracked — force-added past the `*.log` ignore in commit `8ef62e4`; backtick paths, not links.
- Distributable republished from the FINAL tree (`8729bbd`; details below); F1's files untouched.

## Every command, exit status, log path
All logs under `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/fix-wave/` unless noted; every
`npm run <gate>` goes through `scripts/run-gate.mjs`. `E` = `PICO_ADB=/fixture/no/such/adb`
exported in the shell; `D` = NOT exported (the run-gate default carried it); `T` = a tripwire `adb`
first on `PATH`.

| # | Command | Env | Exit | Log |
|---|---|---|---|---|
| 1 | `npm run build` (after I7 edits) | E | 0 | `build-i7.log` |
| 2 | `node --test test/gate-inventory.mjs` (I7 unit test, before any gate used the default) | E | 0 (38/38) | `gate-inventory-i7.log` |
| 3 | `npm run build` (after all code edits) | E | 0 | `build-code.log` |
| 4 | `npm run test:lint` | E | 0 (lint 0 failures; 49/49) | `test-lint-code.log` |
| 5 | `npm run test:prompts` | E | 0 | `test-prompts-code.log` |
| 6 | `npm run test:doors` | E | 0 (Failures: 0) | `test-doors-code.log` |
| 7 | `npm run test:observation` | E | 0 (48/48) | `test-observation-code.log` |
| 8 | `npm run test:sdkselection` | E | 0 (175/175) | `test-sdkselection-code.log` |
| 9 | `npm run test:knowledge-lifecycle` | E | 0 (26/26) | `test-knowledge-lifecycle-code.log` |
| 10 | `npm run test:picocli` | E | 0 (Failures: 0) | `test-picocli-code.log` |
| 11 | `node scripts/sync-metadata.mjs --check` | E | 0 (0 stale, 0 warnings) | `sync-metadata-check-docs.log` |
| 12 | `npm run test:docsmeta` (after docs edits) | E | 0 (26/26; 168 links) | `test-docsmeta-docs.log` |
| 13 | `npm run test:distribution-adoption` (after docs edits) | E | 0 (43/43) | `test-distribution-adoption-docs.log` |
| 14 | `npm run test:lint` (after docs edits) | E | 0 | `test-lint-docs.log` |
| 15 | **Verification step 1:** `npm run build` | E | 0 (190 files, source `eb105535d137`) | `build.log` |
| 16 | **Step 2:** `npm run test:lint` | E | 0 | `test-lint.log` |
| 17 | `npm run test:docsmeta` | E | 0 | `test-docsmeta.log` |
| 18 | `npm run test:distribution-adoption` | E | 0 | `test-distribution-adoption.log` |
| 19 | `npm run test:prompts` | E | 0 | `test-prompts.log` |
| 20 | `npm run test:picocli` | E | 0 (99 s) | `test-picocli.log` |
| 21 | `npm run test:observation` | E | 0 | `test-observation.log` |
| 22 | `npm run test:doors` | E | 0 | `test-doors.log` |
| 23 | `npm run test:sdkselection` | E | 0 | `test-sdkselection.log` |
| 24 | `npm run test:tarball` | E | 0 | `test-tarball.log` |
| 25 | `npm run test:knowledge-lifecycle` | E | 0 | `test-knowledge-lifecycle.log` |
| 26 | `npm run test:buildfreshness` | E | 0 | `test-buildfreshness.log` |
| 27 | `npm run test:plugin-bootstrap-freshness` | E | 0 | `test-plugin-bootstrap-freshness.log` |
| 28 | tripwire self-test: `<tripwire>/adb devices -l` | — | 66 (wrote `adb devices -l`; marker then deleted) | (stdout only) |
| 29 | **Step 3:** `PATH="<tripwire>:$PATH" node scripts/run-battery.mjs "$PWD" …/fix-wave/battery-38.0.0-fixwave.log` | D, T | 1 (53/55) | `battery-38.0.0-fixwave.log` (+ `battery-38.0.0-fixwave.runner.out`; copy at `release/final/battery-38.0.0-fixwave.log`, sha256 `efe7757d…` both) |
| 30 | `npm run test:runrevision` (isolated re-run, same conditions) | D, T | 0 (327/327, 117 s) | `test-runrevision-rerun.log` |
| 31 | **Step 4:** `node scripts/verify-tarball.mjs --publish "$PWD/…/release/final/pico-spatial-mcp-38.0.0.tgz"` | E | 0 (48 checks pass; 14 s) | `verify-tarball-publish.log` |
| 32 | `node -e` receipt read; `shasum -a 256` both tarballs; `stat` | — | 0 | (in this report) |
| 33 | `npm run test:docsmeta` (after the distributable section) | E | 0 (169 links) | `test-docsmeta-final.log` |
| 34 | **Step 5:** `git status`, `git log --oneline 8ef62e4..HEAD`, trailer check | — | clean; 7 commits | — |

## Tripwire result
`evidence/…/fix-wave/adb-tripwire.marker` **does not exist** — checked immediately after the
battery, after the isolated `test:runrevision` re-run, and after the republish. The self-test
proved the script writes and exits 66 (self-test marker removed before the battery). Negative
evidence: no gate child reached an adb through `PATH` with no `PICO_ADB` exported; the run-gate
default carried the barrier for every fixture/installed-artifact child. `printenv PICO_ADB` in
the launching shell: unset.

## Battery summary (step 3)
`PICO gate battery (55 invocations) host: macos` — **53/55 passed, 0 skipped**, 2 failed:
- `test:claims` [exit 1] — **expected red**, host-state snapshot drift, by ruling; not regenerated.
- `test:runrevision` [exit 1] — **not expected; investigated; timing, not a regression.** One case
  (`test/runrevision-locks.mjs:2625`, cross-process capacity enrollment) failed after 18,051 ms with
  the second child's `run-busy: shared acquisition budget expired behind a live capacity
  enrollment` (`ACQUIRE_BUDGET_MS = 15_000`, `src/runlocks.ts:41`). Isolated re-run under identical
  conditions: 327/327 pass, that case 16,365 ms. A 15 s shared budget inside a 16–18 s case on a
  machine mid-battery that had just written 12,285 residue files. No file in this wave touches
  `src/runlocks.ts` or the revision store; the child's only env difference is `PICO_ADB`, which
  the lock path never reads. Not "fixed" (widening a concurrency budget to green a gate is not this
  wave's call); left red in the recorded log; disclosed in the checkpoint (Step 5b + a known-gaps
  row) with a next-sweep suggestion (explicit `deadlineMonotonicMs` for the test).
Both native-contract gates really compiled (2.0 s / 1.7 s).

## New receipt identities (step 4)
From `evidence/…/release/final/pico-spatial-mcp-38.0.0.tgz.receipt.json` (tracked, `8729bbd`):
- artifact `pico-spatial-mcp-38.0.0.tgz`, sha256
  `c08e1a8baf2b850cae5bdd09eb259fab5270645dda3d635eeb1bc7cb51c435f5`, **2,161,859 bytes**
  (`shasum -a 256` on the file agrees).
- package `pico-spatial-mcp@38.0.0`; build input (source identity)
  `eb105535d1378282c4fbaf15c8f111761451173cc8d8e209f52b0c5300654a1c` (195 files) → output
  `5d245218bf71c550eda5a2c8048b3938a96eeffeee71f383f361188c762a6d94` (190 files); TypeScript
  5.9.3; Node major 25; platform darwin/arm64, node v25.8.1; checks 48 pass / 0 fail / 0 skip;
  `limitations`: darwin/arm64 only, no host-plugin discovery, no emulator/device/visual claim.
- **F1's artifact unchanged:** `941e402bb2c234c444e31c62c9bc9dc2c69055ac3aeee48c960e870e100f36d6`,
  2,158,783 bytes; its receipt untouched; labeled "pre-fix-wave, superseded, byte-identical" in the
  checkpoint's Step 6, which now lists the final artifact first with the identities above and a
  resolving relative link to the new receipt. Nothing under `release/` was modified; `release/final/`
  was created fresh. The two artifacts differ because the wave changed shipped `src/` and `scripts/`.

## Not done, and why
- Nothing from the brief was left undone. Code items deliberately not changed are exactly the
  DISCLOSE/LEAVE rulings: perf-lane `emulator-5554` defaults, `toolchainwatch.ts`, `capture.ts:18`
  naming, `[M11]` `/tmp/pico-render/`, `gates.yml:166`.
- `test:runrevision`'s budget was not widened (see above) — a reported red, not a hidden one.
- `docs/claims/claims.json` untouched; `test:claims` not regenerated (ruling).
- The nine seam-bypassing doors were not rerouted (outside I8's scope; disclosed).

## Deviations from the brief, with reasons
1. **`pico_record` ≠ `capture_record` forwarder.** The brief asked to make the schemas of the doors
   forwarding to these tools (`pico_verify_app`, `pico_record`) mirror the inner contract.
   `pico_record` forwards `record_verification`, and no door forwards `capture_record`, so only
   `pico_verify_app` applied — and it already declared `serial` required. No door schema changed.
2. **`src/knowledge.ts:1405` also amended** (the brief named only `:1251`, now `:1253`): the second
   `describePicoCliEnvironmentFailure` site had the identical omission. One-argument change; all
   wording tests green; disclosed here and in the commit message.
3. **Fix-wave text evidence force-added** (`8729bbd`: the `fix-wave/*.log`, the `runner.out`, and
   `release/final/battery-38.0.0-fixwave.log`) rather than left ignored-on-disk. The brief required
   tracking only the receipt; I followed the controller's own durability ruling and `8ef62e4`'s
   convention so the logs survive a worktree removal. The `.tgz` stays untracked. Easy to drop if
   unwanted.
4. **Known-gaps rows added beyond the brief's list** for the three LEAVE minors and the
   `runrevision` timing item, and a "What the fix wave changed" table in the checkpoint, so the
   document's own claims about this wave are complete. Purely additive.
5. **The test name** `S6 matrix: every packer/editor consumer runs the SELECTED 6.1 binary…` in
   `test/toolchain-consumers.mjs` was not renamed although it over-scopes like REVIEW.md rows 1/8
   did: REVIEW.md cites it as the exact test, and renaming would have changed a tracked evidence
   reference. The rows' capability text carries the scoping instead.
6. Intermediate gate runs (rows 1–14) were logged under `fix-wave/` with `-i7`/`-code`/`-docs`
   suffixes in addition to the brief's final sequence (rows 15–34), so every command I ran has a
   retained log.

## Unverified, stated plainly
No emulator, device, native, visual, Windows/Linux or host-discovery evidence was produced or
claimed. The battery's 53 passes and the 48/48 tarball checks are fixture / installed-artifact
checks on this macOS host; the receipt's `limitations` say so. The isolated-green
`test:runrevision` result establishes that the red was a timing margin on this host, not that the
budget is adequate on every host.
