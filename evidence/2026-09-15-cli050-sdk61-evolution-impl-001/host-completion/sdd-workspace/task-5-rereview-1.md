### Finding Verdicts

**IMPORTANT 1 — unreadable receipt bypassed the Node-major gate** — ADDRESSED.
`scripts/build-identity.mjs:254` now returns `present: error.code !== "ENOENT"` in the
`readFileSync` catch block (was `present: false` unconditionally). `scripts/build-identity.mjs:337`
(`verifyDependencies`) still gates on `receipt.present && receipt.nodeMajor !== nodeMajor()` *before*
`matchesHiddenLockfile` is even called (line 341), so an EACCES/EISDIR/EIO receipt now reports
`present: true, nodeMajor: null`, trips the gate, and returns `acceptedBy: null` without the hidden
lockfile being consulted. `crossMajorReason`'s null branch (`scripts/build-identity.mjs:296-298`) was
reworded to a read-failure-agnostic message ("the Node major of the recorded install could not be
read..."), matched by the new test. Covering test:
`test/plugin-bootstrap-freshness.mjs:460-479` ("a receipt that EXISTS but cannot be read is unknown
provenance, not an opening for npm's record") — places a directory at the receipt path (EISDIR on
every platform), asserts a matching hidden lockfile exists first, then asserts `current:false`,
`acceptedBy:null`, `provenance:null`, reasons naming the unreadable receipt and the unknown
provenance, and `doesNotMatch` on hidden-lockfile-consultation phrasing; then removes the directory
and asserts the ENOENT case still adopts (`current:true`, `acceptedBy:"hidden-lockfile"`). RED log
(`fix1-red-unreadable-receipt.log`, embedded in the diff) shows exactly one failure,
`true !== false` at the `verdict.current` assertion — i.e. the unfixed code adopted the unreadable
receipt on npm's record, precisely the defect. GREEN log shows 31/31 (30 pre-existing + this one).
`scripts/plugin-bootstrap.mjs` is the only non-test consumer of `verifyDependencies` (grep-confirmed)
and its `acceptedBy === ACCEPTED_BY.receipt / .hiddenLockfile` branches are unaffected by the
`present` semantics change.

**IMPORTANT 2 — singular `selection` for two independently-resolved components** — ADDRESSED.
`src/toolchainwatch.ts:36-45`: `InstalledToolchainVersions.selection` is now
`{ emulator: ComponentSelection; editor: ComponentSelection }` (new exported union type at line 34).
`installedComponent` (lines 54-74) resolves each component separately via
`resolveToolchain({ required: [component] }, io)` and records that component's own
`{version, rootSource}` or `{unavailable: code}`. `installedVersions` (77-89) builds `selection` from
the two independent results. Docstring (17-28) and tool description (96) both now state the
components are selected separately and may legitimately differ. Covering test:
`test/toolchain-consumers.mjs:1114-1130` — a split-version fixture with the emulator published under
both 6.1 and 0.13 and the editor published **only** under 0.13, asserting
`emulator === "6.1.0"`, `editor === "0.13.3"`,
`selection.emulator === {version:"6.1", rootSource:"PICO_HOME"}`,
`selection.editor === {version:"0.13", rootSource:"PICO_HOME"}`. I independently verified this isn't
a test-fixture coincidence: `src/toolchainselection.ts:591-639` (`selectInstallation`) filters
candidate installations by `missingComponents(install, required)` per call, so calling it once with
`required:["emulator"]` and once with `required:["editor"]` against a root where 6.1 has no editor
payload genuinely forces the editor call to fall back to 0.13 while the emulator call picks 6.1 —
the underlying selection mechanism, not just the new wrapper, is independent per component. RED log
(`fix1-red-per-component-selection.log`) shows the pre-fix failure (`versions.selection.emulator` was
`undefined` against the old flat shape); GREEN shows 177/177.

**FOLDED MINOR 1 — invented `"unavailable/not-resolved"` code** — ADDRESSED.
The literal no longer appears anywhere in `src/toolchainwatch.ts` (grep-confirmed); the new
`installedVersions` builds `selection` directly from the two `installedComponent` results, so there
is no placeholder left to overwrite. `test/toolchain-consumers.mjs:1169` asserts
`doesNotMatch(source, /unavailable\/not-resolved/)`.

**FOLDED MINOR 2 — cast to `UnusableToolchain`** — ADDRESSED.
`as UnusableToolchain` no longer appears in `src/toolchainwatch.ts` (grep-confirmed); replaced by
`isToolchainFailure(selected)` (`src/toolchainwatch.ts:61`), a real type guard
(`value is UnusableToolchain`, defined at `src/toolchain.ts:139-143`) narrowing the
`SelectedToolchain | UnusableToolchain` union `resolveToolchain` returns. I checked
`resolveOperationToolchain`'s extra behavior over plain `resolveToolchain`
(`src/toolchain.ts:156-174`: an `androidProjectRoot` marker check and `$PICO_SPATIALBUNDLE` override)
— the old call site never passed either, so dropping down to `resolveToolchain` is behaviorally
neutral here, not just a claimed equivalence. `npx tsc --noEmit` is reported clean and no other file
imports `installedVersions`/`InstalledToolchainVersions` (grep-confirmed), so the shape/narrowing
change is fully contained.

**FOLDED MINOR 4 — hand-written evidence transcript replaced with a real capture** — ADDRESSED.
New file `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/task-5/fix1-verify-installedversions-default-io-captured.log`
exists on disk; the old `verify-installedversions-default-io.log` has no diff entry and is confirmed
still present, byte-untouched. The new log is a `bash -x` trace (every command echoed by the shell
itself, not transcribed) of two real runs of `installedVersions()` with no `io` argument — i.e. the
production `hostToolchainIO()` path against a real filesystem, `HOME` redirected to an empty
scratch directory so `~/Library/PICO` is never touched: (1) no `PICO_HOME` set → both components
`unavailable/root-unavailable` (self-evidencing: the log shows `DEFAULT_TOOLS_ROOT` resolving inside
the redirected scratch `HOME`, so it could not have silently fallen back to the real
`~/Library/PICO`); (2) `PICO_HOME` at a scratch root carrying a real split-version layout on disk →
`emulator:"6.1.0"`, `editor:"0.13.3"`, each with its own `selection`, which also exercises the editor
metadata read against a real `Spatial Editor.app/.../version` file rather than only fixture io. Both
`t.DEFAULT_TOOLS_ROOT` and `t.hostToolchainIO`/`w.installedVersions` referenced in the captured
invocation are real exports (verified in `src/toolchain.ts:47,52` and `src/toolchainwatch.ts:77`), so
the invocation is plausible as genuinely executed, not fabricated.

### New Breakage in the Fix Diff

None found. Specifically checked and ruled out:
- No dangling references to the removed `resolveOperationToolchain` import or `UnusableToolchain`
  type remain in `src/toolchainwatch.ts` (grep-confirmed).
- The `check_toolchain_updates` handler body (`src/toolchainwatch.ts:101-173`, untouched by this
  diff) only reads `installed.sdkMaven`/`.editor`/`.emulator`, never `installed.selection.*`
  directly, so the `selection` shape change (flat → per-component) cannot have silently broken it
  even though `result` is typed `any`.
- `installedVersions`/`InstalledToolchainVersions` have no other importers anywhere in `src/` or
  `test/` besides `toolchainwatch.ts` itself and `toolchain-consumers.mjs` (grep-confirmed), so the
  type/shape change is fully contained.
- `receiptVerdict` is a private, unexported function; `verifyDependencies` has exactly one
  non-test consumer, `scripts/plugin-bootstrap.mjs` (grep-confirmed), whose only reads of the
  verdict are `acceptedBy`/`current`, unaffected by the `present` semantics fix.
- All 9 named gate logs embedded in the diff (buildfreshness, plugin-bootstrap-freshness,
  sdkselection, doors, picocli, lint, docsmeta, distribution-adoption, prompts) show 0 failures, and
  the two targeted RED logs show exactly one failure each, at the expected assertion, with the
  expected pre-fix value — consistent with genuine TDD rather than asserted-but-unproven claims.

### Out-of-Scope Observations

- The fix report discloses three items from the prior full review round that are **not** in this
  round's required-findings list and were deliberately left open: "Review Minor 3" (the cross-major
  gate's RED was only ever observed at assertion-abort granularity, not gate-isolated — judged
  unrecoverable after the fact) and "Review Minors 5 and 6" (a doors-fixture canned-response
  cosmetic, and a controller-sanctioned one-`npm ci`-per-host cost from a future schema bump). These
  match the task's own findings list (which also skips a "FOLDED MINOR 3"), so this is consistent
  bookkeeping, not a gap in this round's work. Non-blocking.
- All evidence for this task is host-fixture, source-derived, or real-filesystem-scratch; no
  emulator/device/`pico-cli perf` run or rendered frame is involved. The implementer discloses this
  explicitly. Given the task is host-tooling correctness (build scripts, dependency receipts,
  toolchain-selection reporting) rather than spatial-app rendering, this is the appropriate evidence
  class and does not implicate the repo's device/vision verification rule.

### Verdict

**Fix round:** All findings addressed, no new Critical/Important breakage.
