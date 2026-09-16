# CLI 0.5 / SDK 6.1 host-only completion pass — checkpoint (38.0.0)

The merge-ready record of the 2026-09-16 host-only completion pass on branch
`cli050-sdk61-evolution-2026-09-15`. It continues, and does not replace,
[CLI050_IMPLEMENTATION_CHECKPOINT.md](CLI050_IMPLEMENTATION_CHECKPOINT.md) — that document stays
byte-untouched as the record of the 2026-09-15 pass, including its three incidents. Companion:
[CLI050_CAPABILITY_MATRIX.md](CLI050_CAPABILITY_MATRIX.md). Spec:
[../superpowers/specs/2026-09-16-cli050-host-completion-spec.md](../superpowers/specs/2026-09-16-cli050-host-completion-spec.md);
plan: [../superpowers/plans/2026-09-16-cli050-host-completion.md](../superpowers/plans/2026-09-16-cli050-host-completion.md);
release notes: [../../CHANGELOG.md](../../CHANGELOG.md).

**This is a host-only completion checkpoint, not an acceptance.** Six spec items closed five
classes of host-side defect — fixture isolation, gate determinism, artifact preservation, implicit
global log clearing, and host-side correctness — and then the whole 55-gate battery was re-run
against the resulting source. **Nothing native, visual, device-backed, cross-platform or
end-to-end was established here.** No emulator was booted or operated, no device was touched, the
host adb server was never contacted, no frame was captured and no frame was looked at. The
strongest evidence class earned anywhere in this pass is `host-executed`.

## Evidence classes used here

| Class | Meaning | Earned in this pass |
|---|---|---|
| `fixture` | Exercised through production code paths against injected inputs, fake children or a recording fixture `adb`. | yes — the bulk of it |
| `source-derived` | Read from this repository's own source or commits; no execution. | yes — counts, guards, reachability claims |
| `host-executed` | Really ran on this macOS host and the result is retained. | yes — builds, the 55-gate battery, the distributable |
| `native` / `visual` / `device` / `cross-platform` / `end-to-end` | A rendered frame, a real device, another OS, or a whole user journey. | **none** |

## Identity

| | |
|---|---|
| Branch / worktree | `cli050-sdk61-evolution-2026-09-15` in `.worktrees/cli050-sdk61-evolution-2026-09-15` |
| Base commit | `dfb3f2d` — the tip of the 2026-09-15 pass, the commit its checkpoint describes |
| Tip | **this document's own commit** (`git log -1` names it); it sits directly on `4022939`, the task-6 evidence commit |
| Commits in `dfb3f2d..HEAD` | 39 including this one, every one ending `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` |
| Release version | **38.0.0** — unchanged (ruling below) |
| Source files | 192 `src/*.ts`; 98 `test/*.mjs` |
| Build receipt input sha256 (source identity) | `bafeb2712c5b635d18a2a6a4523b41dc7a7eeee6e940bbe95c214822cd0628db` (197 input files) |
| Build receipt output sha256 | `f4978b711f570efda70ef91f4a8c8157cadc231daab7ccc103909a36ee61c24d` (192 published `dist/*.js` + `dist/build-receipt.json`) |
| Toolchain | Node `v25.8.1`, TypeScript `5.9.3`, macOS (`darwin-arm64`) |
| Tool surfaces | unchanged — 255 on macOS (installed-tarball runtime-measured), a source-derived 252 on Linux and Windows, 18 doors |
| Nothing pushed | `main` untouched, no history rewritten, no `git stash` used |

All of the above is `source-derived` except the build receipt digests and the toolchain, which are
`host-executed`.

### Version: 38.0.0 stands, with a caveat that must be checked before release

**Ruling (controller).** The version stays `38.0.0`. No tarball of this line has been distributed:
both earlier `.tgz` files exist only under this repository's evidence directories (and the main
checkout's copy), so nothing keyed on the manifest version has reached a host. The three artifacts
are distinguished by directory and by receipt identity, not by version.

**The reviewer's caveat, recorded verbatim in substance and not waived.** A release *is* a version
bump in this repository, and hosts key `/plugin update` off the manifest version. Three
byte-different `38.0.0` tarballs with different tool contracts now exist. If **any** tester holds
an earlier `38.0.0` `.tgz`, the version must be bumped before release — `/plugin update` would
otherwise refuse to move them onto the contract described here. Whoever ships this is responsible
for answering that question first; this checkpoint cannot.

## What each task changed

Each row: the spec item, what landed, the commits, the tests with their counts, the review verdict
and fix rounds, and the evidence directory. Every evidence directory below is under
`evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/`.

### Task 1 — fixture isolation (spec item 1)

- **What changed.** `gateChildEnv` (`scripts/gate-inventory.mjs`) now REPLACES whatever `PICO_ADB`
  the shell inherited for every `fixture` / `installed-artifact` gate child — a real adb, an empty
  string and whitespace are all discarded. The single pass-through is `PICO_GATE_FIXTURE_ADB`
  naming an absolute executable file; anything else refuses the gate (exit 2) from
  `scripts/run-gate.mjs` before a child exists. `src/adb.ts`'s `classifyAdbOverride` makes a blank
  `PICO_ADB` an explicit, rejected override that probes nothing. `src/doors.ts` routes every door
  through `doorCall()` / `doorCallRaw()`, keyed on the presence of a `dependencies` object, so a
  `{}` fixture server can spawn no inner server; exactly three `await inner()` sites remain.
  Controller fold-in before review: the doctor's adb row (`src/preflight.ts`) and the native fleet
  receipt reader (`src/nativefleetreceipt.ts`) apply the same blank rule instead of carrying their
  own.
- **Commits.** `641ec84`, `0af0055`, `313c03a`, fold-in `33ec6b8`, controller evidence `070e4a8`.
- **Tests.** `test/gate-inventory.mjs` 46/46; `test/toolchain-cache.mjs` 33/33; `test:doors` 17/17
  with a new 16/16 "every door refuses through the seam on a `{}` fixture" block and a
  source-derived three-`inner()`-sites assertion; `test:sdkselection` 176/176; lint, docsmeta,
  distribution-adoption, picocli green.
- **Review.** opus — spec ✅, quality **Approved**, 0 Critical, 0 Important, 12 Minor. No fix round.
- **Evidence.** [../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-1/](../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-1/) (26 logs)

### Task 2 — deterministic gates (spec item 2)

- **What changed.** `test/claimspage.mjs` section 2 builds a whole ledger from scratch in a
  temporary `PICO_MCP_LEDGER_DIR` through the real writer API — one row of every evidence class
  plus a retraction, `device_verified` driven by injected identity/capture probes — and compares it
  to a committed expected manifest. The tracked-snapshot consistency checks are unchanged; the real
  ledgers and `docs/claims/` are untouched; comparison against the live ledger is opt-in with
  `PICO_CLAIMS_LIVE_LEDGER=1` on the ledger-owning machine. `test/runrevision-locks.mjs`'s two
  capacity-child spawners set `PICO_RUNLOCK_CHILD_CLOCK_SCALE` so the child's clock, not the
  production budget, is what the test controls. No production limit, budget or assertion changed.
- **Commits.** `06c71ca`, `fba0a6d`, `c13fea6` on `hc/t2-deterministic-gates`, merged `--no-ff` as
  `c6f6cef`.
- **Tests.** `test:claims` exit 0 three times (baseline: exit 1); `test:runrevision` 327/327 three
  times, with the failure mode reproduced on demand at clock scale `2`; lint, docsmeta,
  distribution-adoption green.
- **Review.** sonnet — spec ✅, quality **Approved**, 0 Critical, 0 Important, 3 Minor. No fix round.
- **Evidence.** [../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-2/](../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-2/) (14 logs)

### Task 3 — artifact preservation (spec item 3)

- **What changed.** `scripts/publish-tarball.mjs`'s `land()` is link-or-refuse: every
  `LINK_UNSUPPORTED` errno now raises `PUBLISH_NO_ATOMIC_PUBLICATION` instead of falling back to a
  replacing `rename()`, and `rename` was removed from the injectable `PUBLISH_IO` seam so no
  replacing primitive is left to reach for. `capture_canonical` (`src/eye.ts`) and `emulator_look`
  default to run-unique RETAINED paths under the observation root through one shared helper
  (`src/capturepaths.ts`) instead of the fixed `/tmp/pico-render/*.png` files a second capture
  overwrote. **Their default TARGET is unchanged**, as the spec requires.
- **Commits.** `b6d8d63`, `e36cb68`, `8956eae` on `hc/t3-artifact-preservation`, merged `--no-ff` as
  `37daef2`.
- **Tests.** `test/publish-tarball.mjs` 11/11 including a per-errno refusal case; `test:tarball`
  green; `test:eye` green with four new checks; `test:observation` 50/50; doors, lint, docsmeta,
  distribution-adoption green.
- **Review.** sonnet — spec ✅, quality **Approved**, 0 Critical, 0 Important, 4 Minor. No fix round.
- **Evidence.** [../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-3/](../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-3/) (19 logs)

### Task 4 — no implicit global log clearing (spec item 4)

- **What changed.** New `src/logwindow.ts` owns one mechanism: write ONE marker line
  (`adb -s <serial> shell log -t pico-mcp <marker>`), read a bounded dump
  (`logcat -d -v threadtime -t <n>` with tag filters that always admit the marker tag), slice after
  the marker. Nothing is removed from the device. Every implicit clear is gone — `assert_scene`,
  `probe_planes`, the copilot snapshot loop, `build_and_run`, `pico_loop`, `wait_for_log`'s default
  and `assert_logcat`'s `clearFirst`, plus the boundary experiment's prepare step. An unseen marker
  is INCONCLUSIVE at every site and is never matched against the unscoped buffer; `pico_loop` maps
  it to `unmeasurable` so it can never drive a replan. The one explicit destructive clear that
  remains, `logcat clear:true` (`src/adb.ts:382`), now requires an explicit serial, checked before
  any sole-device resolution.
- **Commits.** `c5662f3`, `80fb227`.
- **Tests.** new `test/logwindow.mjs` (19/19 at landing) drives every replaced site through a
  recording fixture `adb` that trips exit 97 on any clear; `test:observation` 67/67;
  `test:lint` 57/57; `smoke` 11/11 with a new "no global log clear" check; doors,
  emulator-restart, conformance, preflight, picocli, docsmeta, distribution-adoption, copilot,
  placeonsurface, sdkselection 176/176, adoption-safety, vault, smoke-isolation green.
- **Review.** opus — spec ✅, quality **Approved**, 0 Critical, 0 Important, 8 Minor. No fix round.
- **Evidence.** [../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-4/](../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-4/) (25 logs)

### Task 5 — host-side correctness (spec item 5)

- **What changed.** Dependency receipts carry `nodeMajor`; `verifyDependencies()` returns
  `provenance` (`"npm-ci" | "hidden-lockfile" | null`). Hidden-lockfile adoption never crosses a
  Node major and never turns unknown provenance into a verified installation identity — a receipt
  from another major, one with no readable `nodeMajor`, and (after fix round 1) one that is present
  but unreadable or wrong-shaped all reinstall rather than adopt. `check_toolchain_updates`
  (`src/toolchainwatch.ts`) resolves through the same component-valid selection as everything else
  and reports per-component `installed.selection` (`{emulator, editor}`) instead of one shared
  field. The `pico_perf` door takes an optional `device` and forwards it; `perf_diagnose` reports
  `requestedDevice` on every outcome. Historical `0.13.3` provenance references are preserved and
  exempted from the scan.
- **Commits.** `0c9c6e5`, `6691d14`, `f437500`, `cf0da79`; fix round 1: `e1ae6c5`, `0f163f5`.
- **Tests.** `test:buildfreshness`, `test:plugin-bootstrap-freshness`, `test:sdkselection` (177/177
  after the split-version fixture), `test:doors`, `test:picocli`, `test:lint`, `test:docsmeta`,
  `test:distribution-adoption`, `test:prompts` green; adjacent runrevision, conformance, runreceipt,
  preflight green.
- **Review.** opus — spec ❌ on the first pass (2 Important: an unreadable receipt bypassed the
  `nodeMajor` gate; one shared `selection` misreported a split-version host), quality **Needs
  fixes**, 6 Minor. **One fix round** (findings I1, I2 plus three folded minors, one of them an
  evidence-honesty correction: a hand-written transcript replaced by the captured invocation),
  then a scoped re-review (sonnet): all addressed, no new breakage.
- **Evidence.** [../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-5/](../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-5/) (40 logs).
  Merge evidence for T2/T3 into the integration branch:
  [../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/merge-t2-t3/](../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/merge-t2-t3/) (7 logs, commit `3cd1b67`).

### Fix wave FW1 — the whole-pass review's findings (spec item 6, first half)

The independent whole-pass review (fable, read-only, over `dfb3f2d..0f163f5`) returned **0 Critical,
1 Important, 11 Minor**, spec alignment **exact on items 1–5**, and "ready to merge with fixes".
One fix wave followed, then one scoped re-review.

- **What changed.** (1) IMPORTANT — the bounded-window contract said long pollers raise `maxLines`
  and no caller did: `assert_logcat` and `wait_for_log` gained an optional `maxLines`
  (100..200000, default 20000), `build_and_run` reads with 20000, `pico_loop` asks `assert_logcat`
  for 50000 because its marker precedes a multi-minute `fleet_build`, and the module's two false
  doc sentences were replaced by named constants and their callers. (2) MINOR — four polling sites
  keep `lastReadError`, so a dead adb is reported as a dump failure instead of log eviction
  (`unseenMarkerCause`). (3) MINOR — the logcat-clear source guard was inverted: it now finds every
  clear spelling across `src/*.ts`, asserts exactly one, and asserts its explicit-serial form,
  instead of pinning `adb.ts:382`. (4) MINOR — `PICO_GATE_FIXTURE_ADB` is refused when its realpath
  is an `adb` found on the caller's PATH or up to three levels under `$PICO_HOME` or
  `~/Library/PICO` (filesystem reads only; no spawn). (5) MINOR — `pico_look` names its retained
  default target and its lack of a serial input. (6) MINOR — the AGENTS.md `gates.yml` wording.
  (7) MINOR — a gitignored SDD working file was untracked (`git rm --cached`, no history rewrite).
- **Commits.** `3b6679d`, `0cb2b71`, `9c26b2f`, `7ec1fa0`, `9d26429`, `a6712a1`, `e474048`, plus
  `c68979d` and `1c752d2` (whitespace-only re-wraps of one AGENTS.md paragraph to 100 columns).
- **Tests.** `test/logwindow.mjs` 29/29; `test/gate-inventory.mjs` 52/52; `test:observation` 79/79;
  `test:doors` 17/17; `test:emulator-restart` 690 tests / 689 pass / 1 pre-existing off-Darwin skip;
  `test:lint` 63/63; `test:docsmeta` 26/26; `test:distribution-adoption` 43/43; `test:prompts`,
  `test:picocli`, `smoke`, `test:smoke-isolation`, `test:copilot` green.
- **Re-review.** opus, scoped to `0f163f5..e474048` — all 7 findings ADDRESSED, no new
  Critical/Important. Four Low residuals recorded (below).
- **Evidence.** [../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/fixwave/](../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/fixwave/) (36 logs)

### Task 6 — this checkpoint (spec item 6, second half)

- **What changed.** Two description/comment-only source edits closed the re-review's Low residuals
  (1) and (4): the `maxLines` input descriptions on `assert_logcat` and `wait_for_log` now say the
  bound applies to the WINDOWED read — the one `clearFirst` opens or `sinceMarker` names — and that
  an unwindowed read dumps the whole buffer, where the input is inert; `src/logwindow.ts`'s
  default-bound caller list now also names the boundary experiment's prepare read. No behavior
  changed. Then [../../CHANGELOG.md](../../CHANGELOG.md)'s `38.0.0` section (the false run-gate
  sentence replaced with the enforced rule, plus this pass's whole wire contract),
  [../../AGENTS.md](../../AGENTS.md)'s re-derived dist-import count, the `perf` rows of
  [CLI050_CAPABILITY_MATRIX.md](CLI050_CAPABILITY_MATRIX.md), the battery, the artifact and this
  file.
- **Commits.** `896b589` (the two description edits), `54ce696` (the doc corrections), `4022939` (evidence),
  and this document's own commit.
- **Evidence.** [../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-6/](../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-6/)
  and `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/host-completion/`.

## Incidents of this pass

**One incident, and it is host scratch, not hardware.** During Task 3's RED phase, the new
`capture_canonical` test called the tool with no `outPath` while the implementation still pointed
at the fixed path, so the handler wrote the test's PNG fixture (sha256 `457aadfa…`, 12,420 bytes)
over `/tmp/pico-render/canonical.png` once, at 03:25 local. **The prior bytes are not
recoverable.** That is the defect itself, reproduced live: a default LOOK capture destroying an
earlier frame under the same name. It is host scratch — nothing under `evidence/` was touched, and
no repository file cites that path by digest except `docs/claims/` rows already marked
`provenance-broken` before this session. **It cannot recur after the fix**: the default is now a
run-unique retained path, and the test writes only under a temporary `HOME`. `source-derived` +
`host-executed`; disclosed by the implementer with file, digest and mechanism rather than hidden.

**No emulator, device or host adb server was contacted in this pass.** Not once, by any task, in
any phase — including every RED run. No MCP tool, no `pico_doctor`, no managed CLI store, no npm
registry, no change to the global CLI or `PATH`, nothing under `~/.pico-mcp`, and no edit, build or
migration of the paused Mission Replay project. The only reads outside the checkout were read-only
filesystem lookups used to size the fixture-adb hatch guard: a `find` under `~/Library/PICO` (no
adb present) and a per-`PATH`-entry existence check.

**The 2026-09-15 incidents are referenced, not rewritten.** They stay exactly as written in
[CLI050_IMPLEMENTATION_CHECKPOINT.md](CLI050_IMPLEMENTATION_CHECKPOINT.md) §"Negative evidence —
three RED runs reached real hardware, and one of them did damage": Incident 1 (a real
`adb devices -l`), Incident 2 (the real SDK, the real device list, the host scratch frame) and
Incident 3 (~20 irreversible logcat-buffer clears of the user's emulator). They were constraint
violations, not acceptable RED-phase exceptions. What this pass changes is that **the mechanism
behind Incident 3 no longer exists**: no observation path can clear a device log, and the one
explicit clear left requires a named serial. And the mechanism behind Incidents 1 and 2 is now
**enforced rather than remembered**: every fixture and installed-artifact gate child is pinned to
`PICO_ADB=/fixture/no/such/adb` whatever the shell held, the one documented hatch
(`PICO_GATE_FIXTURE_ADB`) must name an absolute executable fake and is refused when its realpath is
a real adb, and a blank `PICO_ADB` fails closed in `src/adb.ts`, in the doctor's adb row and in the
native fleet receipt reader.

## The final required battery

**Method** (`host-executed`). Run from this worktree with **no `PICO_ADB` exported** — the run-gate
default is what pins every gate child, and this run exists to prove that it does — and with a
marker-writing tripwire `adb` first on `PATH`: a script that appends its argv, pid, ppid and cwd to
a marker file and exits 66. The tripwire was self-tested first (it recorded `argv=devices` and
exited 66) and the self-test marker deleted before the run. A copy of the script is retained as
`evidence/…/host-completion/task-6/step4-tripwire-adb.sh`; the preconditions (`PICO_ADB` unset,
`command -v adb` resolving to the tripwire, HEAD) are in `step4-battery-preconditions.log`.

```
node scripts/run-battery.mjs "$PWD" \
  "$PWD/evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/host-completion/battery-38.0.0-host-completion.log"
```

**Result.**

```
BATTERY PASS 55/55 (0 failed)
```

Exit 0. **Every one of the 55 gates passed; none was skipped.** The runner appends a skip summary
when a `native-contract` gate belongs to another OS; on this macOS host it names none, and the log
confirms the two macOS-native suites really compiled and ran their contracts rather than taking the
off-Darwin no-op path (`test:vcamtransport-native` and `test:vcamreader-native`, exit 0 each). Two
skips inside otherwise-passing gates are worth naming exactly, because neither is a gate skip:
`test:emulator-restart` carries the pre-existing `frontmostQemu returns null without command
execution off Darwin # SKIP`, which skips precisely because this host IS Darwin; and
`test:vcamreader-native` logs "reader is authorized; skipping the readback-block assertion to stay
device-free" — one assertion deliberately not made, so that a native gate never touches a camera
device.

- Aggregate log: `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/host-completion/battery-38.0.0-host-completion.log`
- Runner stdout: `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/host-completion/battery-38.0.0-host-completion.runner.out`
- **Tripwire: the marker file does not exist.** Nothing in the battery resolved `adb` from `PATH`.
- The `WARN homepage/origin check skipped: ENOTDIR … .git/config` line inside `test:docsmeta` is
  **worktree noise, not a failure**: `.git` is a file rather than a directory in a worktree. It is
  pre-existing and appears in every worktree run.

**Test-count changes against the 2026-09-15 final battery** (`host-executed`, both sides):

| Gate | Then | Now | Why |
|---|---|---|---|
| `test:observation` | 48 | **79** | T4 registered `test/logwindow.mjs` (+ the FW1 dump-failure cases) |
| `test:lint` | 49 | **63** | gate-inventory's hatch cases (T1 + FW1) |
| `test:sdkselection` | 175 | **177** | T5's split-version toolchain fixture |
| `test:plugin-bootstrap-freshness` | 27 | **31** | T5's provenance/Node-major cases |
| `test:claims` | **FAIL (exit 1, red by ruling)** | **PASS** | T2's fixture ledger |
| `test:runrevision` | 327 (timing-fragile) | **327 (deterministic)** | T2's controlled child clock |
| `test:emulator-restart` | 690 / 689 pass / 1 skip | unchanged | the one skip is the pre-existing `frontmostQemu … off Darwin # SKIP` |
| `test:doors`, `test:tarball`, `test:conformance`, `test:docsmeta`, `test:distribution-adoption`, `test:picocli`, `test:prompts`, `test:buildfreshness` | 17 / 11 / 69 / 26 / 43 / 157+22 / 3 / 26 | unchanged | counts equal; contents changed inside `test:doors` (the 16/16 seam block) |

Before the battery, the same source was rebuilt and eighteen targeted gates were run one at a time
with a log each under
[../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-6/](../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-6/):
`test:lint`, `test:docsmeta`, `test:distribution-adoption`, `test:doors`, `test:sdkselection`,
`test:observation`, `test:eye`, `test:tarball`, `test:claims`, `test:runrevision`,
`test:buildfreshness`, `test:plugin-bootstrap-freshness`, `test:picocli`, `test:conformance`,
`test:emulator-restart`, `test:preflight`, `test:prompts`, `smoke` — all exit 0.

## Artifact lineage — three `38.0.0` tarballs

All three were produced by `node scripts/verify-tarball.mjs --publish <file>` from this worktree.
The `.tgz` files are deliberately untracked; **the receipts are tracked** and are the record.

| # | Artifact (untracked) | sha256 | Bytes | Build input sha256 / files | Build output sha256 / files | Checks | Status |
|---|---|---|---|---|---|---|---|
| F1 | `evidence/…/release/pico-spatial-mcp-38.0.0.tgz` | `941e402bb2c234c444e31c62c9bc9dc2c69055ac3aeee48c960e870e100f36d6` | 2,158,783 | `e51cb8f1b72b…` / 195 | `68a3d0a73884…` / 190 | 48/48 pass | **superseded**, byte-unchanged |
| FW1 | `evidence/…/release/final/pico-spatial-mcp-38.0.0.tgz` | `c08e1a8baf2b850cae5bdd09eb259fab5270645dda3d635eeb1bc7cb51c435f5` | 2,161,859 | `eb105535d137…` / 195 | `5d245218bf71…` / 190 | 48/48 pass | **superseded**, byte-unchanged |
| HC | `evidence/…/release/host-completion/pico-spatial-mcp-38.0.0.tgz` | `ff394fbbcdf1828ea0745e3d7ad4fe931a2a46e7b910ea309f67c82c6858d042` | 2,176,424 | `bafeb2712c5b…` / 197 | `f4978b711f57…` / 192 | 48/48 pass | **current** |

Receipts (tracked, beside each artifact):
`evidence/…/release/pico-spatial-mcp-38.0.0.tgz.receipt.json`,
`evidence/…/release/final/pico-spatial-mcp-38.0.0.tgz.receipt.json`,
`evidence/…/release/host-completion/pico-spatial-mcp-38.0.0.tgz.receipt.json`.

**The two earlier tarballs are byte-unchanged**, re-verified with `shasum -a 256` during this task
(`step5-earlier-tarballs-unchanged.log`): both digests match the values above exactly. Nothing
already under `evidence/` was modified or deleted by this pass —
`git diff --diff-filter=DM dfb3f2d..HEAD -- evidence/` is empty.

## Forward pointers — rows of the 2026-09-15 checkpoint that this pass made stale

The older document is a historical record and is **not** edited. Read these corrections beside it.

| Where, in [CLI050_IMPLEMENTATION_CHECKPOINT.md](CLI050_IMPLEMENTATION_CHECKPOINT.md) | What it says | What is true now |
|---|---|---|
| §"A fourth finding…" — "unless the caller set one — a caller-set value always wins" | A caller-set `PICO_ADB` overrode the fixture pin. | **Reversed by Task 1.** An inherited value (real, blank or whitespace) is REPLACED. The only pass-through is `PICO_GATE_FIXTURE_ADB` naming an absolute executable fake, refused when its realpath is a real adb. |
| §"Known gaps" — `capture_canonical` / `pico_look` keep the fixed `/tmp/pico-render/canonical.png` path | Two `pico_look` calls overwrite each other's frame. | **Closed by Task 3** for `capture_canonical` and `emulator_look`: run-unique retained paths. The **default target** is still `emulator-5554`, retained by ruling (below). |
| §"Known gaps" — `[M11]` leaves an empty `/tmp/pico-render/` on the host | Expected leftover from the installed-doors canary. | **No longer expected.** The canary's capture path is run-unique under a fixture `HOME`; an empty `/tmp/pico-render/` is no longer produced by a verify run. |
| §battery and §"Known gaps" — `test:claims` "red by ruling" / "reads host state as if it were repository state" | The gate was deliberately left red on this host. | **Closed by Task 2.** `test:claims` is green here against a fixture ledger; the live-ledger comparison is opt-in and `docs/claims/` is still untouched. **There is no "red by ruling" exception anywhere in this pass.** |
| §"Known gaps" — `test:runrevision`'s capacity case runs a 15 s budget inside a 16–18 s case | Timing-fragile; red once in a battery, green in isolation. | **Closed by Task 2** with an explicit test-only child clock scale. `ACQUIRE_BUDGET_MS` and every assertion are unchanged. |
| §"Known gaps" — `check_toolchain_updates` reads the 0.13 emulator/editor paths directly | Never routed through selection. | **Closed by Task 5**: per-component selection, per-component `installed.selection`. |
| §"Known gaps" — `perf_diagnose` / `pico_perf` cannot even name a device | The door took only `packageName` and `durationSec`. | **Half closed by Task 5**: `pico_perf` accepts `device` and both report `requestedDevice`. The **default target** is unchanged. |
| §"Known gaps" — nine doors bypass the injection seam | A fixture server driving one would spawn the real inner server. | **Closed by Task 1**: every door goes through the seam; three `inner()` sites remain, and `test:doors` proves 16/16 refusals on a `{}` fixture. |
| The `CHANGELOG.md` 38.0.0 sentence "…unless the caller set one" | Same false rule, in the release notes. | **Replaced in this task** with the enforced rule. |

## Remaining acceptance limits — precisely what 38.0.0 still does not establish

### Externally blocked (needs hardware, a provisioned payload, another OS, or the user's word)

| Item | Exact state |
|---|---|
| **Profiler payload provisioning** | Still unprovisioned. Every perf `--help` observation exited at the CLI's utilities gate, so **no perf or trace route has a retained exit-0 help example on either version line**. Provisioning requires the user to run the CLI's own `setup` command manually; this server does not, and nothing in this pass changed that. |
| **Host-plugin discovery** | No host has loaded these manifests. Claude Code, Codex and Cursor discovery is unverified. Closing it needs: host + version, plugin/source identity, the expanded command, the startup result and the observed tool requests. |
| **Real Linux and Windows `tools/list`** | Zero measurements. The macOS 255 is an installed-tarball runtime measurement; the **252 is source-derived** from the three-tool host-GUI registration delta. `test:picocli-win` is a fixture gate that runs on any OS and measures nothing about Windows. |
| **Emulator LOOK acceptance** | Not performed, deliberately. Calibration has been stale since the 2026-09-15 boot (calibrated 2026-09-04 against a boot of `2026-09-15T08:33:50Z`), and **root alone owns `emulator-5554`**: this pass did not boot, calibrate, move, resize or otherwise operate it to make a check green. |
| **A physical device** | Untouched. A device run happens only if the user authorizes it. |
| **`emulator_look`'s runtime path** | Untested and untestable here: it needs a real qemu window, macOS Accessibility permission and a real CGEvent drag. Task 3's change to it is covered by the shared helper's own tests, a source scan and code-path inspection only. Recommended check when the emulator is available to its owner: call it twice and confirm both files survive under `~/.pico-mcp/cli/observations/emulator-look/<runId>/`. |
| **Mission Replay** | Paused and unchanged. Not edited, built, installed or migrated; its earlier native evidence is **not** SDK 6.1 acceptance. |

### Known gaps retained by ruling or disclosed by design

| Item | Exact state |
|---|---|
| **Retained default targets** | `pico_look`, `capture_canonical` and `emulator_look` still default to `emulator-5554`; `perf_diagnose` and `pico_perf` still default to `DEFAULT_PERF_DEVICE` (`src/perfcli.ts:74`, also `emulator-5554`). Retained by ruling — the spec asked for unique retained paths and explicit device pass-through and said preserving capture history does not require changing the default target. All four are disclosed in their own tool descriptions; `pico_look`'s door text names its default and states it has no serial input. |
| **Marker eviction on a real device is unmeasured** | logd applies `-t <n>` to the selected buffers BEFORE the client-side tag filter, so a chatty XR runtime can push the window marker out of the tail while the filtered output stays tiny. **An evicted marker is `inconclusive` (or `unmeasurable` through `pico_loop`) — never a pass, ever.** The exposure is real: `pico_loop` writes its marker BEFORE `fleet_build` (a multi-minute Gradle build + install + launch + settle) and therefore asks `assert_logcat` for 50000 lines; `probe_planes` can poll up to 60 s on the 4000-line default bound. The eviction rate on real PICO hardware has never been measured, and this pass could not measure it. |
| **`maxLines` is inert on an unwindowed read** | With `clearFirst:false` and no `sinceMarker`, `assert_logcat` and `wait_for_log` dump the whole buffer with no `-t`, so the bound does nothing. Both input descriptions now say so (this task); the behavior is unchanged and deliberate — there is no marker to slice after. |
| **The boundary experiment's prepare step replays the backlog** | It no longer clears `-b all`; its bounded read is correlated to a marker instead, and the owned streaming collector that starts afterwards now begins with whatever the buffer already held. Consequence: **a truncated 64 MB window is a hard run failure**, not a larger file — an aborted experiment, with `structuralStop: "log_window_evicted"` when the marker is unseen. |
| **Twelve fixed `/tmp/pico-render` defaults remain in `src/`** | Out of Task 3's scope and unchanged: `cameradrive.ts:718` (`capture_orbit`) and `:757` (multiview), `capturerig.ts:74`, `verifyvisual.ts:48`, `verifybaseline.ts:34`, `virtualcamera.ts:123–124`, `splatanalyze.ts:256`, `semanticsplat.ts:154`, `hybridbuild.ts:127`, `fleetbuild.ts:1175`, `webspatialmv.ts:212`, `editorv32.ts:105,112`. Each can still overwrite an earlier frame under the same name. `observation.ts:818` is already run-unique. |
| **The `PICO_GATE_FIXTURE_ADB` hatch exists by design** | It is the one documented pass-through, and it is what a harness uses to hand a gate a fake adb. It is validated as an absolute executable file and refused when its realpath is an `adb` found in a directory on the caller's PATH or up to three levels under `$PICO_HOME` or `~/Library/PICO` — filesystem reads only, no spawn. Symlinked *directories* are not followed, so a real adb reachable only that way would pass: this is read-only hardening of a documented hatch, not a proof. Two pre-existing hatch tests pass an env with no `HOME`, so the guard falls back to `os.homedir()` and walks the real, **adb-free** `~/Library/PICO` read-only; their assertions cannot vary by machine (the override is a fresh temp file), so this is host I/O, not flake. |
| **The `adb-resolution` receipt stage is narrowly reachable** | `NativeFleetFailureStage` gains `adb-resolution` (`src/nativefleetreceipt.ts:431`), but `fleet_build` passes `ADB()` eagerly (`src/fleetbuild.ts:1222`, `:1243`), outside the producer's envelope — so in production `fleet_build`'s own throw is the user-visible refusal and the stage is reachable only for a caller that omits `adbPath`. Type-only addition to a persisted `…V1` union; no stored receipt changes shape. |
| **A corrupt or old-shape receipt costs one `npm ci`** | Deliberate (ruled). A receipt that is present but unreadable or wrong-shaped has unreadable provenance, so adoption refuses and the host reinstalls once. The same rule means an `IDENTITY_SCHEMA_VERSION` bump costs every host one `npm ci` instead of a free hidden-lockfile adoption. |
| **The inverted logcat-clear guard keeps a 20-line proximity pin** | `test/logwindow.mjs` no longer pins `adb.ts:382` by line number, but it does require the `if (clear) {` branch to sit within 20 lines above the clear (`test/logwindow.mjs:832`). Far less brittle than a line pin; still a structural coupling worth knowing about. |
| **`unseenMarkerCause` still says "evicted" when nothing was attempted** | With zero successful dumps and no recorded error — reachable only if a poll loop never iterates, which the schema minimums make near-impossible — the hint falls back to the plain eviction text. One edge of the same misattribution class the fix removed. Next sweep. |

## What this checkpoint is not

It is not a native, visual, device, cross-platform or end-to-end acceptance, and no line in it may
be read as one. Exit zero, a help listing, a green gate and a nonempty file establish nothing about
a rendered frame. Under this repository's one non-negotiable rule, **"verified" means someone
LOOKED at a rendered frame** — and nobody looked at one in this pass, because no frame was
produced. The battery, the artifact and the receipts are `host-executed` evidence about this
source on this macOS host, and that is the whole of what they say.
