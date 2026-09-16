# Task 5 report — host-side correctness: receipt provenance and Node major, selected-tool toolchain watch, explicit perf device

Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-sdk61-evolution-2026-09-15`
Branch: `cli050-sdk61-evolution-2026-09-15`, from `3cd1b67`.
Version stays `38.0.0`. Nothing under `evidence/` was modified or deleted; new logs live in a fresh
directory. No push, no history rewrite, no `git stash`. The emulator, any device, the host adb
server, MCP tools, the managed CLI store, the npm registry, the global CLI/PATH, `~/Library/PICO`
and the Mission Replay project were never touched. `PICO_ADB=/fixture/no/such/adb` was exported in
every shell that ran tests.

## Commits

| SHA | Subject |
| --- | --- |
| `0c9c6e5` | fix: dependency receipts carry Node major and provenance; hidden-lockfile adoption never crosses majors or claims npm-ci |
| `6691d14` | fix: check_toolchain_updates reads the selected toolchain, not a hardcoded 0.13 install |
| `f437500` | fix: pico_perf carries an explicit device through to perf_diagnose |

Each commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## What was implemented

### 1. Receipt provenance and Node major (`scripts/build-identity.mjs`, `scripts/plugin-bootstrap.mjs`)

`npm ci` resolves optional and native dependencies against the running Node major, so the tree it
laid down under one major is not evidence about another. `node_modules/.package-lock.json` records
WHICH artifacts were installed and never which runtime installed them, so it can agree with
`package-lock.json` down to the last integrity hash and still describe a tree this Node cannot use.
The bootstrap then adopted that agreement and wrote it down as a first-class receipt — unknown
provenance laundered into a verified-looking install identity.

- `dependencyReceipt` records `nodeMajor: nodeMajor()`. The identity already folds the major in,
  but an identity is a digest: once it stops matching it can no longer say *why*. A receipt that
  names its major can.
- `receiptVerdict` now also returns `present` (a receipt file was read at all), `nodeMajor` (null
  when the file could not be read far enough to carry one) and `source`.
- `verifyDependencies(root)` returns `{ current, acceptedBy, provenance, identity, reasons }`.
  `provenance` is `"npm-ci" | "hidden-lockfile" | null`.
  - a current receipt → `acceptedBy: "receipt"`, `provenance: receipt.source`. A current receipt is
    same-major by construction (the identity folds the major in), so the gate below cannot apply to
    it.
  - a **present** receipt whose `nodeMajor !== nodeMajor()` — a different number, **or no recorded
    major at all** (the pre-change shape, and an unparsable/wrong-schema file) — returns
    `{current:false, acceptedBy:null, provenance:null}` **without consulting `matchesHiddenLockfile`**.
    Reasons: the receipt's own reasons plus either
    `installed under Node <a>, running Node <b>; the hidden lockfile cannot vouch for native or
    optional dependencies across majors, so this install is reinstalled`
    or, for an unknown major, `…does not record the Node major it was installed under, so that
    install's provenance is unknown; <same clause>`.
  - the hidden-lockfile path (no receipt present) → `acceptedBy: "hidden-lockfile"`,
    `provenance: "hidden-lockfile"`.
  An adopted receipt therefore stays receipt-fast on later starts (`acceptedBy: "receipt"`) while
  still reporting `provenance: "hidden-lockfile"` — it never starts claiming `npm-ci`.
- `adoptInstalledDependencies` is exported from `scripts/plugin-bootstrap.mjs` and now writes, on
  success: `pico-spatial-mcp bootstrap: dependencies accepted on npm's hidden lockfile (provenance
  recorded as hidden-lockfile; this bootstrap did not perform the install)`. The failure line is
  unchanged.

### 2. `check_toolchain_updates` on the selected toolchain (`src/toolchainwatch.ts`)

`installedVersions` read `~/Library/PICO/sdk/0.13/emulator/package.xml` and the 0.13 editor's
`version` file from module-scope literals, so on a host carrying 0.13 beside 6.1 it reported the
LEGACY payload as installed and the verdict advertised an upgrade the host already had.

`installedVersions(io: ToolchainIO = hostToolchainIO())` now resolves the emulator and editor
through `resolveOperationToolchain({ required: [c], primary: c }, io)` — the same per-call selection
`src/editorpalette.ts` uses — and reads `package.xml` / the editor `version` file *relative to the
selected installation's binary*, through that `io`. It returns
`{ emulator, editor, sdkMaven, selection: { version, rootSource } | { unavailable: code } }`.
The emulator (the cross-platform component) names the selection when it resolved; the editor
answers for it otherwise; when neither resolves, the selection layer's own structured
`unavailable/*` code is reported rather than an invented path.

Preserved on purpose: `out.sdkMaven = "6.0.0"` with its `// the gradle dependency line our scaffolds
pin` comment, and the `<release> was 0.13.3` provenance comment in the Maven block. The only `0.13`
strings left in the file are comments (one of them the new note recording exactly what the old
hardcoded literals were).
Removed on purpose: the `?? "0.13.x"` emulator fallback. It was a guess about a *hardcoded* install;
with selection there is nothing left to guess from, so an absent metadata file is now `"unknown"`,
matching what the editor half already did.

### 3. Explicit perf device (`src/doors.ts`, `src/perfcli.ts`)

- `pico_perf` gains `device: z.string().optional().describe("adb serial to profile; forwarded
  verbatim. Omitted: the wrapper's documented default target.")`, forwarded verbatim to
  `perf_diagnose`. zod strips undeclared keys, which is why the old door silently sent every
  door-driven run to the default target. Omitting `device` forwards **no** `device` key, so the
  wrapper's default still decides.
- **No default changed.** `DEFAULT_PERF_DEVICE` is untouched, `perf_diagnose`'s and `perf_trace`'s
  default targets are untouched, and both remain disclosed in their descriptions.
- `perf_diagnose`'s description now says the result reports `requestedDevice`.

**Deviation to flag (deliberate, disclosed).** The brief's interface line says "result *already*
carries `requestedDevice`". It did not: `requestedDevice` existed only as an internal argument to
`adaptPerfReport`, used to validate the report's `metadata` device, and was never returned. Writing
the brief's description sentence over the code as it stood would have made the tool description
false, which this repo's contract forbids. I made the sentence true instead, with the smallest
change that covers every outcome: `collectPerfLive` is now a four-line wrapper around the existing
body (`{ ...(await collectPerfLiveResult(...)), requestedDevice: request.device }`), so a graded
run, a capability refusal, a failed/timed-out run and an unusable report all name their target; and
`runPerfDiagnose` computes the device before `ensurePicoCli()` so even its `unavailable` early
return names it. `requestedDevice` was added to `PerfDiagnoseResult` and to the tool's
`outputSchema` (which is `.passthrough()`, so no consumer contract was narrowed). If the reviewer
prefers the description reworded instead, reverting the field is a two-hunk revert.

## TDD evidence, step by step

All logs under
`/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-sdk61-evolution-2026-09-15/evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-5/`.

| Step | Phase | Log | Result |
| --- | --- | --- | --- |
| 1 | RED (tests written first) | `step1-red-bootstrap-missing-export.log` | exit 1 — `SyntaxError: … does not provide an export named 'adoptInstalledDependencies'`; 0 pass / 1 fail |
| 2 | RED (assertion level, after only the export + stderr line existed) | `step2-red-bootstrap-assertions.log` | exit 1 — 28 pass / **2 fail**: `a receipt must record the Node major that installed the tree`; `npm's record is never reported as an install of ours` |
| 3 | GREEN | `step3-green-plugin-bootstrap-freshness.log`, `step3-green-buildfreshness.log` | 30/30 and 26/26, exit 0 |
| 4 | RED | `step4-red-toolchainwatch.log` | exit 1 — 176 pass / **1 fail**: `TypeError: installedVersions is not a function` |
| 5 | GREEN | `step5-green-sdkselection.log` | 177/177, exit 0 |
| 6 | RED | `step6-red-doors.log` | exit 1 — `FAIL pico_perf dropped or rewrote the explicit device: … args:{"packageName":"com.example.fixture","durationSec":10}` (the `device` key stripped by zod, exactly the defect) |
| 6 | GREEN | `step6-green-doors.log`, `step6-green-picocli.log` | doors 78 checks / 17 suites, picocli 157 checks / 22 suites, both exit 0 |

The third bootstrap test (the adoption stderr line) was RED only at module level in step 1 — the
line it asserts did not exist in `scripts/plugin-bootstrap.mjs` before that commit — and was already
green by step 2 because the export and the message shipped in the same edit. Noted rather than
claimed as an independent assertion-level RED.

Tests use the suites' own fixture helpers, as instructed: `createCheckout` /
`installDependenciesInto` / `writeHiddenLockfile` / `recordCurrentInstall` / `createWarmCheckout` /
`recordingSpawn` / `recordingCompiler` in `test/plugin-bootstrap-freshness.mjs`; `mixedHostIO` /
`toolchainIOFromTree` / `S6_ROOT` in `test/toolchain-consumers.mjs`; the C5 raw/domain lane fixture
(`rawCalls`, `responses`, `sameJson`) in `test/doors.mjs`. No real `npm ci`, no registry contact, no
process spawned against a device.

The toolchainwatch fixture carries **both** a 0.13 and a 6.1 payload with **different declared
revisions**, so reading the wrong one is a wrong answer rather than a lucky one; it additionally
asserts `io.reads` contains no `/0.13/` path, and scans `src/toolchainwatch.ts` for an executed
`sdk/0.13` literal or `os.homedir` (comments exempt).

## Verification

`npm run build` first, every time (`final-build.log`: `published 192 file(s) for source b73820a0cee3`).

| Gate | Result |
| --- | --- |
| `test:buildfreshness` | PASS |
| `test:plugin-bootstrap-freshness` | PASS |
| `test:sdkselection` | PASS |
| `test:doors` | PASS |
| `test:picocli` | PASS |
| `test:lint` | PASS |
| `test:docsmeta` | PASS |
| `test:distribution-adoption` | PASS |
| `test:prompts` | PASS |

Adjacent gates run because this task touched `src/perfcli.ts` and the receipt code
(`adjacent-*.log`): `test:runrevision` PASS, `test:conformance` PASS, `test:runreceipt` PASS,
`test:preflight` PASS. `npx tsc --noEmit` clean.

One extra check beyond the fixtures, because every assertion above runs against an injected
in-memory io: `verify-installedversions-default-io.log` calls `installedVersions()` with **no
argument** — the production `hostToolchainIO()` path against a real filesystem — with `PICO_HOME`
pointed at a scratch root carrying both a 0.13 and a 6.1 emulator payload. It returns
`{emulator:"6.1.0", editor:"unknown", sdkMaven:"6.0.0", selection:{version:"6.1",
rootSource:"PICO_HOME"}}`. Read-only; `~/Library/PICO` was neither read nor written, and the scratch
root was removed afterwards.

## Files changed

| File | Change |
| --- | --- |
| `scripts/build-identity.mjs` | `dependencyReceipt` records `nodeMajor`; `receiptVerdict` reports `present`/`nodeMajor`/`source`; new `crossMajorReason`; `verifyDependencies` gains `provenance` and the cross-major / unknown-major gate |
| `scripts/plugin-bootstrap.mjs` | `adoptInstalledDependencies` exported; success stderr line naming the provenance and disclaiming the install |
| `src/toolchainwatch.ts` | `installedVersions(io?)` exported, on `resolveOperationToolchain`; `InstalledToolchainVersions` type; tool description names the selection; hardcoded 0.13 paths and `os.homedir` gone from executed code |
| `src/doors.ts` | `pico_perf` input gains `device` (the only edit in this file) |
| `src/perfcli.ts` | `requestedDevice` on `PerfDiagnoseResult` + `outputSchema`; `collectPerfLive` wrapper stamps it on every outcome; `runPerfDiagnose` resolves the device before its first failure point; `perf_diagnose` description and `device` input description |
| `test/plugin-bootstrap-freshness.mjs` | 3 new tests (cross-major + unknown-major gate, provenance across adoption, adoption stderr line); imports `matchesHiddenLockfile`, `adoptInstalledDependencies` |
| `test/toolchain-consumers.mjs` | 1 new test: selected emulator/editor versions, `selection` provenance, the `unavailable/*` refusal, a payload-less selection, linux, and the source scan |
| `test/doors.mjs` | 2 new checks on the C5 lane fixture: explicit `device` forwarded verbatim; omitted `device` forwards no key |
| `test/picocli.mjs` | 2 new checks: `requestedDevice` on a graded result and on a refusal |

## Self-review findings

- **Completeness.** Node-major gate present and covers the pre-change (no `nodeMajor`) shape;
  provenance never laundered (an adopted receipt reports `hidden-lockfile` forever); toolchainwatch
  on the selection with `selection` provenance and the structured refusal; perf device forwarded
  verbatim; `0.13.3` / `6.0.0` historical references preserved.
- **Discipline (YAGNI).** No default target changed. The only addition beyond the brief's literal
  text is the `requestedDevice` result field, added because the brief's own description sentence
  would otherwise have been false; flagged above.
- **Blast radius checked.** `verifyDependencies` / `dependencyReceipt` have exactly one non-test
  consumer (`scripts/plugin-bootstrap.mjs`); grepped and confirmed. The existing suites that drive
  malformed receipts do so with **no** hidden lockfile present, so the new gate changes none of
  their outcomes — verified by the green run, not by reading.
- **One behaviour change worth naming for review:** a receipt file that is present but unparsable,
  or carries the wrong `schemaVersion`, now also blocks hidden-lockfile adoption (its Node major is
  unreadable, so its provenance is unknown). Before, such a checkout could still be accepted on
  npm's record. This follows the controller's "a receipt without `nodeMajor` … is treated as unknown
  provenance and also not adopted" ruling and the file's own "unknown is never current" rule; the
  cost is one `npm ci` on a checkout with a corrupt receipt.

## Concerns

1. The `requestedDevice` deviation above — the one place where I did more than the brief's literal
   text, and the reason is recorded.
2. Everything proved here is **host fixture / source-derived evidence**. No emulator, device,
   `pico-cli perf` run, or rendered frame was involved, so nothing in this task establishes visual
   or device acceptance. In particular, `pico_perf {device: …}` is proven to *forward* a serial
   through the door seam; it has not been run against a second real device.
3. `test/plugin-bootstrap-freshness.mjs`'s new stderr test monkey-patches `process.stderr.write` for
   the duration of one `runBootstrap` call and restores it in a `finally`. It is the only way to
   observe the line without threading a writer through the bootstrap's signature; it is scoped and
   restored, but it is a global for the length of that call.

## Log paths (absolute)

Directory:
`/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-sdk61-evolution-2026-09-15/evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-5/`

RED: `step1-red-bootstrap-missing-export.log`, `step2-red-bootstrap-assertions.log`,
`step4-red-toolchainwatch.log`, `step6-red-doors.log`.
GREEN per step: `step3-green-plugin-bootstrap-freshness.log`, `step3-green-buildfreshness.log`,
`step5-green-sdkselection.log`, `step6-green-doors.log`, `step6-green-picocli.log`.
Final sweep: `final-build.log`, `final-buildfreshness.log`,
`final-plugin-bootstrap-freshness.log`, `final-sdkselection.log`, `final-doors.log`,
`final-picocli.log`, `final-lint.log`, `final-docsmeta.log`,
`final-distribution-adoption.log`, `final-prompts.log`.
Adjacent: `adjacent-runrevision.log`, `adjacent-conformance.log`, `adjacent-runreceipt.log`,
`adjacent-preflight.log`.
Production default io: `verify-installedversions-default-io.log`.

---

# Fix report — review round 1 (commit `e1ae6c5`)

Two Important findings plus three folded minors, all fixed in the same worktree, TDD as before.
`npm run build` before every test run; `PICO_ADB=/fixture/no/such/adb` exported throughout. Nothing
under `evidence/` was modified or deleted — the superseded `verify-installedversions-default-io.log`
is left exactly as it was, and the replacement is a new file.

## IMPORTANT 1 — an existing-but-unreadable receipt bypassed the gate

**What changed.** `scripts/build-identity.mjs` `receiptVerdict`: `present: false` → `present:
error.code !== "ENOENT"`. ENOENT is the only absence; EACCES, EISDIR and EIO are a receipt that is
here and cannot be accounted for, which is unknown provenance, not a clean slate. The docstring at
`:241` now says that in the same words the code enforces.

`crossMajorReason`'s null branch was reworded with it. It used to read "`.pico-dependencies.json`
does not record the Node major it was installed under" — a claim about file *contents*, which is not
something we can assert about a file we could not read. It now reads "the Node major of the recorded
install could not be read from `.pico-dependencies.json`, so its provenance is unknown; …", which is
true for every way the field can be missing: the pre-change shape, an unparsable file, an unknown
`schemaVersion`, and now an unreadable one. The numeric branch keeps the brief-mandated
`installed under Node <a>, running Node <b>` wording verbatim. One earlier assertion was updated to
the new phrase; no gate pins either string.

**Covering test.** `test/plugin-bootstrap-freshness.mjs` — *"a receipt that EXISTS but cannot be read
is unknown provenance, not an opening for npm's record"*. It puts a **directory** where the receipt
belongs, which yields EISDIR on every platform without needing to drop privileges or rely on
`chmod 000` behaviour under a test runner, with a **matching** hidden lockfile (asserted via
`matchesHiddenLockfile(root).matches === true` first, so the test proves something). It asserts
`current:false`, `acceptedBy:null`, `provenance:null`, reasons matching both
`/\.pico-dependencies\.json is unreadable \(EISDIR/` and
`/Node major of the recorded install could not be read/`, and — the part that proves the gate ran —
`doesNotMatch(/npm has no record|hidden lockfile records|does not list/)`, i.e. `matchesHiddenLockfile`
contributed no reason because it was never consulted. It then removes the directory and asserts the
ENOENT case is *still* adopted (`current:true`, `acceptedBy:"hidden-lockfile"`), which is what keeps
`present` a distinction rather than a blanket refusal.

**RED.** `fix1-red-unreadable-receipt.log` — 30 pass / 1 fail,
`AssertionError … true !== false` at `test/plugin-bootstrap-freshness.mjs:470`
(`assert.equal(verdict.current, false)`). That `true` **is** the defect: the unreadable receipt was
accepted on npm's record.

## IMPORTANT 2 — `selection` was singular but resolved per component

**What changed.** `src/toolchainwatch.ts`. `installedVersions` now returns
`selection: { emulator: ComponentSelection; editor: ComponentSelection }`, each either
`{ version, rootSource }` or `{ unavailable: <structured code> }`. A new exported type
`ComponentSelection` names the union. The module docstring and the `check_toolchain_updates`
description both now state that each component is selected on its own and that the two may
legitimately differ on a half-upgraded host — replacing the promise that one field named where
*both* versions came from.

The per-component work moved into one helper, `installedComponent(io, component, fileName, parse)`,
which resolves, records where it resolved, then reads that installation's metadata file. Three
distinct outcomes stay distinguishable: selection refused (`{unavailable: code}`, version
`"unknown"`), selection fine but the component file absent from `files` (`"unknown"` against a real
selection), and selection fine but the metadata file absent or unparsable (same). No guesses.

**Covering test.** `test/toolchain-consumers.mjs`, same test, extended: a split-version fixture with
an emulator under both 6.1 and 0.13 and an editor **only** under 0.13. It asserts
`emulator === "6.1.0"`, `editor === "0.13.3"`,
`selection.emulator === {version:"6.1", rootSource:"PICO_HOME"}` and
`selection.editor === {version:"0.13", rootSource:"PICO_HOME"}`. The pre-existing cases were
converted to the per-component shape, and the linux case now asserts
`selection.editor === {unavailable:"unavailable/component-unsupported-platform"}` beside a resolved
emulator — the case a single shared field could not express without lying about one of them.

**RED.** `fix1-red-per-component-selection.log` — 176 pass / 1 fail,
`AssertionError … Expected values to be strictly deep-equal` on the first per-component assertion.

## FOLDED MINOR 1 — dead invented code

`selection: { unavailable: "unavailable/not-resolved" }` is gone; the new return builds `selection`
directly from the two component results, so there is no placeholder to overwrite. The test now
asserts `doesNotMatch(source, /unavailable\/not-resolved/)`, so it cannot come back.

## FOLDED MINOR 2 — the cast

`as UnusableToolchain` is gone. Rather than narrow around `OperationToolchain`'s nullable
`selection` — which would have left an unreachable branch needing *some* code to report —
`installedComponent` resolves through `resolveToolchain({ required: [component] }, io)`, the
component-valid selection layer the brief itself named (`resolveHostToolchain` is that call bound to
`hostToolchainIO()`, and takes no `io`). Its return is a clean two-case
`SelectedToolchain | UnusableToolchain` union that `isToolchainFailure` narrows in one line, exactly
as the finding asked. Nothing else about the resolution changes: `resolveOperationToolchain` already
delegated to `resolveToolchain` for the same request, and this module used neither of the two things
it adds (an `androidProjectRoot` claim and `$PICO_SPATIALBUNDLE` override handling). The test's
source scan was updated to pin the entry point actually used:
`/resolveToolchain\(\{ required: \[component\] \}, io\)/`. `npx tsc --noEmit` clean.

## FOLDED MINOR 4 — real captured evidence

New file (the old one untouched):
`evidence/…/host-completion/task-5/fix1-verify-installedversions-default-io-captured.log`.
It is the raw stdout+stderr of `bash -x`, so every command is echoed **by the shell** immediately
before it runs — no transcription, no paraphrase. Two runs against the PRODUCTION default io
(`hostToolchainIO()` over the real filesystem), both under `HOME` redirected to an empty scratch
directory:

1. no `PICO_HOME` — the program prints `osHomedir` and `DEFAULT_TOOLS_ROOT` itself, and
   `DEFAULT_TOOLS_ROOT` is
   `…/scratchpad/fix1/fakehome/Library/PICO/sdk`. That is the self-evidencing part the old log was
   missing: the documented default root is `~/Library/PICO/sdk` expanded through `os.homedir()` at
   import (`src/util.ts:108-112`), so with `HOME` redirected this machine's own `~/Library/PICO` is
   not a path this process can reach. The result is `unavailable/root-unavailable` for **both**
   components — had it fallen back anywhere else, it would not be.
2. `PICO_HOME` at a scratch root carrying the split-version layout — `emulator: "6.1.0"` from 6.1,
   `editor: "0.13.3"` from 0.13, each with its own selection. This also closes the review's
   "cannot verify from diff alone" note that the **editor read path** was only ever exercised by the
   fixture io: here it reads a real `Spatial Editor.app/Contents/MacOS/version` off a real disk.

`find` output for both scratch trees is captured in the same log, so what the process could see is
visible rather than asserted. The scratch trees were removed afterwards.

## Commands and results

```
$ npm run build                                   # published 192 file(s) for source 45870a98806a
$ npm run --silent test:plugin-bootstrap-freshness   PASS  (31 tests, 31 pass, 0 fail)
$ npm run --silent test:buildfreshness               PASS
$ npm run --silent test:sdkselection                 PASS  (177 tests, 177 pass, 0 fail)
$ npm run --silent test:doors                        PASS
$ npm run --silent test:prompts                      PASS
$ npm run --silent test:lint                         PASS
$ npm run --silent test:picocli                      PASS
$ npm run --silent test:docsmeta                     PASS
$ npm run --silent test:distribution-adoption        PASS
```

Logs (all force-added, `fix1-` prefix, in
`/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-sdk61-evolution-2026-09-15/evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-5/`):
`fix1-red-unreadable-receipt.log`, `fix1-red-per-component-selection.log`,
`fix1-green-plugin-bootstrap-freshness.log`, `fix1-green-buildfreshness.log`,
`fix1-green-sdkselection.log`, `fix1-build.log`, `fix1-gate-*.log` (nine),
`fix1-verify-installedversions-default-io-captured.log`.

## Not fixed, and why

- **Review Minor 3** (the cross-major gate never had an *isolated* RED; the step-2 run aborted at
  the earlier `receipt.nodeMajor` assertion) is a fact about a run that has already happened and
  cannot be re-created honestly after the fact. It is recorded here rather than papered over. The
  closest thing this round produces is `fix1-red-unreadable-receipt.log`, which *is* an isolated RED
  for the same gate's unreadable branch and shows the laundering directly (`current: true`).
- **Review Minors 5 and 6** were not in the fix list. Minor 5 (the doors fixture reusing one canned
  `perf_diagnose` response for both calls) is cosmetic — both assertions read only the forwarded
  args. Minor 6 (a future `IDENTITY_SCHEMA_VERSION` bump now costs one `npm ci` per host instead of
  a free adoption) is deliberate and controller-sanctioned; it is carried forward here so it is not
  rediscovered as a surprise.

## Concerns after this round

Unchanged from the first report, minus the two that were fixed. The `requestedDevice` deviation
stands as reviewed ("judged on its merits: correct"). All evidence remains host-fixture,
source-derived or real-filesystem-scratch — no emulator, device, `pico-cli perf` run or rendered
frame is involved, so nothing here establishes device or visual acceptance.
