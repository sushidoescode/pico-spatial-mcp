# Task 5 review — host-side correctness: receipt provenance and Node major, selected-tool toolchain watch, explicit perf device

Reviewed: `3cd1b67..cf0da79` (4 commits). Read-only review; no working-tree, index, HEAD or branch
mutation, no emulator/device/adb/MCP/npm-registry/managed-store access. No test suite re-run.

### Spec Compliance

- ❌ Issues found: two disclosure/gate gaps, both small and local (Important #1 and #2 below).
  Everything the brief and the controller decisions asked for is present and implemented; the gaps
  are in branches neither the brief nor the tests reach.

Item-by-item against the brief and the controller refinements:

- ✅ Receipt records `nodeMajor` — `scripts/build-identity.mjs:132`, with a comment explaining why a
  digest that already folds the major in still needs a field that can say *why* it stopped matching.
  Consistent with the pre-existing build receipt, which already carried `nodeMajor`
  (`scripts/build-identity.mjs:359`, untouched).
- ✅ `verifyDependencies(root)` returns `{ current, acceptedBy, provenance, identity, reasons }` —
  `scripts/build-identity.mjs:311-337`; `provenance` is `"npm-ci" | "hidden-lockfile" | null`
  (values from `RECORDED_SOURCE`, `scripts/build-identity.mjs:25`).
- ✅ Cross-major receipt blocks hidden-lockfile adoption and forces a reinstall, **without**
  consulting `matchesHiddenLockfile` — `scripts/build-identity.mjs:329-331`, gate placed before the
  `matchesHiddenLockfile` call at `:333`.
- ✅ `reasons` name `installed under Node <a>, running Node <b>` verbatim —
  `scripts/build-identity.mjs:286-291` (`crossMajorReason`).
- ✅ A receipt without `nodeMajor` is unknown provenance and is also not adopted — same gate, via
  `receipt.nodeMajor !== nodeMajor()` with `nodeMajor: null` for the pre-change shape
  (`scripts/build-identity.mjs:266`), and its own reason text at `:289`.
- ✅ An adopted receipt stays receipt-fast with `provenance: "hidden-lockfile"` —
  `scripts/build-identity.mjs:327` returns `provenance: receipt.source`, and the adoption writes
  `source: RECORDED_SOURCE.hiddenLockfile` (`scripts/plugin-bootstrap.mjs:276`). Asserted end-to-end
  at `test/plugin-bootstrap-freshness.mjs:462-481`.
- ✅ Bootstrap stderr line says accepted-on-npm's-record, not performed or verified —
  `scripts/plugin-bootstrap.mjs:277-280`, exact brief wording. Asserted, including a negative on
  `/verified|installed by this bootstrap/i`, at `test/plugin-bootstrap-freshness.mjs:502-503`.
- ✅ `installedVersions` resolves emulator and editor through the selection layer with an injected
  `ToolchainIO` — `src/toolchainwatch.ts:49-51`. The brief's literal `resolveHostToolchain(...)` takes
  no io parameter (`src/toolchain.ts:89-91`), so `resolveOperationToolchain(request, io)` is the only
  reading that satisfies the controller's injected-io requirement; it also matches the
  `src/editorpalette.ts` precedent the neighbouring test already pins.
- ✅ Returns `{ emulator, editor, sdkMaven, selection }` with `selection` provenance or the structured
  `unavailable/*` code — `src/toolchainwatch.ts:26-35`, `:65-67`.
- ✅ `sdkMaven = "6.0.0"` kept with its comment (`src/toolchainwatch.ts:59`); every `0.13.3`
  provenance reference kept, and the only surviving `0.13` strings in the file are comments
  (`src/toolchainwatch.ts:19-20`, `:126-127`).
- ✅ `pico_perf` gains `device: z.string().optional()` forwarded verbatim — `src/doors.ts:580`, handler
  at `:582-585` passes `args` through unchanged.
- ✅ `perf_diagnose` / `perf_trace` DEFAULT targets retained and disclosed — `DEFAULT_PERF_DEVICE`
  untouched at `src/perfcli.ts:74`, disclosed at `src/perfcli.ts:761`; `perf_trace` is not in the diff
  and still discloses its own default at `src/perftrace.ts:566`.
- ✅ The only `src/doors.ts` edit is the `pico_perf` door — one hunk, `@@ -566,22 +566,26 @@`.
- ✅ Nothing under `evidence/` modified or deleted; 25 new files, no `deleted file mode` and no
  `--- a/evidence` in the diff. `AGENTS.md`, `CHANGELOG.md` and the checkpoint documents are not in
  the file list; `package.json` is not either, so the version stays 38.0.0.
- ✅ No emulator/device/MCP/npm-registry/`~/Library/PICO` activity in the change or its tests: the
  toolchain tests drive in-memory `ToolchainIO` fixtures (`test/toolchain-consumers.mjs:1090-1140`),
  the perf tests drive the injected `collectPerfLive` runtime seam, and the doors test uses the C5
  raw/domain call lane.

**Disclosed deviation — `requestedDevice` added to the result, judged on its merits: correct.** The
brief asserted the result "already carries `requestedDevice`". It did not: `requestedDevice` existed
only as an `adaptPerfReport` validation argument (`src/perfcli.ts:245`, consumed at `:292-294`) and
was never returned. Writing the brief's sentence over the code as it stood would have made a shipped
tool description false. The chosen fix is minimal and total: a four-line wrapper
(`src/perfcli.ts:412-416`) stamps every outcome, and the device is hoisted above `ensurePicoCli()`
(`src/perfcli.ts:635`) so even the `unavailable` early return names its target (`:644`). Additive and
optional on a `.passthrough()` schema (`src/perfcli.ts:756`), so no consumer contract narrowed.

⚠️ Cannot verify from diff alone:
- Commit-message trailers (controller states these are already verified; not re-checked).
- That `~/Library/PICO` was untouched during the production-default-io check. See Minor #4 — that
  log is a hand-written transcript, not raw output.
- The editor read path against a real filesystem. `verify-installedversions-default-io.log` returned
  `editor: "unknown"`, so only the fixture io exercises it. I checked the layout instead and it is
  right: `editor` resolves to `<root>/<version>/editor/Spatial Editor.app/Contents/MacOS/<bin>`
  (`src/toolchainselection.ts:122-123`), so `dirname(bin)/version` reproduces the old hardcoded path
  exactly; likewise `emulator` (`src/toolchainselection.ts:116`) and `dirname(bin)/package.xml`.

### Strengths

- The cross-major gate is placed **after** the `receipt.current` short-circuit
  (`scripts/build-identity.mjs:327` then `:329`). That is the detail that decides whether this change
  is safe to ship: an existing healthy checkout whose pre-change receipt has no `nodeMajor` still
  returns `acceptedBy: "receipt"` and never reaches the gate, so the bootstrap fast path
  (`scripts/plugin-bootstrap.mjs:303`) is unchanged and no reinstall storm is possible. A pre-change
  receipt that *is* stale pays exactly one `npm ci`, after which `installDependencies` writes the new
  shape (`scripts/plugin-bootstrap.mjs:261`). Named risk (b): cleared.
- Blast radius is genuinely one consumer. `verifyDependencies` has exactly one non-test caller
  (`scripts/plugin-bootstrap.mjs:303,306,311`), and it reads only `.acceptedBy` and `.current`, both
  preserved. `scripts/run-gate.mjs` and `scripts/build-source.mjs` do not reference it at all. Named
  risk (a): cleared.
- The RED evidence is real and names the exact absent behavior, not a generic failure:
  `step2-red-bootstrap-assertions.log:47` (`undefined !== 25` on the receipt's `nodeMajor`) and `:70`
  (`+ undefined / - 'hidden-lockfile'` on `provenance`); `step4-red-toolchainwatch.log`
  (`TypeError: installedVersions is not a function`); `step6-red-doors.log` shows the forwarded args
  literally missing the `device` key — the defect itself, not a proxy for it.
- The toolchainwatch fixture is discriminating rather than lucky: both a 0.13 and a 6.1 payload with
  *different declared revisions*, plus an assertion that `io.reads` contains no `/0.13/` path
  (`test/toolchain-consumers.mjs:1099`), plus an executed-source scan that exempts comments
  (`:1145-1151`) so the preserved `0.13.3` provenance notes cannot be scanned away by mistake.
- Four selection edge cases are covered, not one: both payloads present, nothing selectable
  (`unavailable/root-unavailable`), a selection whose metadata files are absent (`"unknown"`, not a
  guess), and linux where the editor is not published at all
  (`test/toolchain-consumers.mjs:1102-1140`).
- Removing the `?? "0.13.x"` emulator fallback is the right call and is reasoned, not incidental: it
  was a guess about a hardcoded install, and with selection there is nothing left to guess from. The
  verdict string only interpolates the value (`src/toolchainwatch.ts:152`) and never compares it, so
  `"unknown"` cannot regress the verdict.
- The perf `requestedDevice` wrapper writes the *request* over whatever the inner result carried
  (`src/perfcli.ts:415`, with the reason in the docstring at `:406-410`) — the request is the
  authority on what was asked for, which is the honest ordering.
- `test/doors.mjs:460-468` asserts the omitted case forwards **no** `device` key, not merely that it
  forwards the default. That is what actually pins "no default changed".

### Issues

#### Critical (Must Fix)

None.

#### Important (Should Fix)

**1. An existing-but-unreadable receipt still bypasses the new gate — the laundering path is closed
for parsed receipts and open for unreadable ones.** `scripts/build-identity.mjs:249-251` returns
`present: false` for *every* `readFileSync` failure, including EACCES and EISDIR, while its own
reason text on the same line says the file "is unreadable" — i.e. it demonstrably exists. Because the
gate is `receipt.present && …` (`:329`), a checkout with a root-owned or otherwise unreadable
`.pico-dependencies.json` skips the gate entirely, `matchesHiddenLockfile` is consulted (`:333`), and
a cross-major tree is accepted with `acceptedBy: "hidden-lockfile"` — the reinstall is skipped and the
wrong tree is used. This contradicts the function's own docstring two lines above
(`scripts/build-identity.mjs:241-242`: "`nodeMajor` is null whenever the file could not be read far
enough to carry one — a recorded install of unknown provenance"), which describes exactly this case
but is not what the code does. It also contradicts the spec constraint the task exists to establish
("must not … turn unknown provenance into verified installation identity"). Fix is one expression:
`present: error.code !== "ENOENT"`. No existing assertion depends on the current value — the only
test that drives this branch is the ENOENT case at `test/plugin-bootstrap-freshness.mjs:337`.

**2. `selection` is singular but is resolved per component, so it can name the wrong installation for
`editor`.** `src/toolchainwatch.ts:50-51` issues two independent selections with different `required`
sets, and `required` filters candidate installations (`src/toolchainselection.ts:611`, `:628`), so the
two calls can legitimately resolve to *different versions*. `src/toolchainwatch.ts:65-67` then reports
only the emulator's. On a host that upgraded the emulator to 6.1 but not the editor — two separately
downloaded payloads, so an ordinary state — the tool returns `{emulator: "6.1.0", editor: "0.13.3",
selection: {version: "6.1"}}`, while the interface doc at `src/toolchainwatch.ts:33` promises
`selection` is "where the two versions above were read from" and the tool description at `:76`
promises it "discloses which installation was read". For a task whose subject is *which installation a
version came from*, that is a disclosure that can be false. The split case is not covered by the new
test, which pins only same-version (`test/toolchain-consumers.mjs:1096-1099`) and editor-absent
(`:1134-1139`). Minimal honest fix: have `selection` name the emulator's selection explicitly in both
docstring and description, or report the editor's selection alongside it when the two differ. Add the
split-version fixture either way.

#### Minor (Nice to Have)

1. `src/toolchainwatch.ts:59` initialises `selection: { unavailable: "unavailable/not-resolved" }` and
   then overwrites it unconditionally at `:66`/`:67`. The placeholder is dead, and in a module whose
   contract is "the selection layer's own structured code … instead of an invented location" an
   invented code string that can never be emitted is exactly the wrong thing to leave for a reader to
   grep.
2. `src/toolchainwatch.ts:67` casts a possibly-successful `OperationToolchain` to `UnusableToolchain`
   to read `.code`. It is safe today only because the `named?.selection` guard at `:66` is unreachable:
   `selection: null` requires a `binaryOverride`, which requires `allowBinaryOverride && primary ===
   "packer"` (`src/toolchain.ts:179`), and `installedVersions` passes neither. If that precondition
   ever changes the cast yields `{ unavailable: undefined }` against a declared `unavailable: string`.
   A narrowing check instead of a cast costs one line.
3. TDD granularity: the cross-major gate itself never had an isolated RED.
   `step2-red-bootstrap-assertions.log:47` aborts at the earlier `receipt.nodeMajor` assertion
   (`test/plugin-bootstrap-freshness.mjs:432`), so the run that would have shown `current: true /
   acceptedBy: "hidden-lockfile"` with `nodeMajor` recorded but no gate was never captured. The report
   is honest about the sibling case (the stderr test being green at step 2) but does not name this one.
4. `evidence/…/task-5/verify-installedversions-default-io.log` is a hand-written transcript with a
   paraphrased command line (`$ PICO_HOME=<scratch> node -e 'installedVersions()'`), not captured
   output. Its load-bearing claim — "`~/Library/PICO` was never read or written" — is therefore not
   self-evidencing, in a repo whose contract is that evidence is what you can look at. Capturing the
   real invocation and its stdout would cost nothing.
5. `test/doors.mjs:449-452` sets one canned `perf_diagnose` response carrying
   `requestedDevice: "fixture-serial"` and reuses it for the no-device call at `:464`. Harmless — both
   assertions read only the forwarded args — but the fixture reads as though the default target
   answered with an explicit serial.
6. Named in the report and worth carrying forward: an unparsable or wrong-`schemaVersion` receipt now
   also blocks adoption (`scripts/build-identity.mjs:245`, `:253-255`), which means a future
   `IDENTITY_SCHEMA_VERSION` bump costs every host one `npm ci` instead of a free hidden-lockfile
   adoption. Deliberate and controller-sanctioned; just not obvious from the constant's definition.

### Checks run (beyond reading the diff)

- Consumers of the changed API: `grep verifyDependencies|writeDependencyReceipt|dependencyReceipt`
  over `src/ scripts/ test/ .github/` — one non-test consumer, reading only `.acceptedBy`/`.current`.
- Named risk (b): traced the `receipt.current` short-circuit at `scripts/build-identity.mjs:327` and
  the bootstrap fast path at `scripts/plugin-bootstrap.mjs:303`; pre-change receipt on a healthy
  checkout never reaches the gate.
- Named risk (c): `readInstalledVersion` (`src/toolchainwatch.ts:38-43`) reads only
  `dirname(selected.bin)/<file>`; component dirs confirmed at `src/toolchainselection.ts:116,122-123`;
  `hostToolchainIO().read` catches and returns null (`src/toolchain.ts:57-63`). No read outside the
  selected installation, and the same root class the old hardcoded path already used.
- Named risk (d): `PerfDiagnoseResult` consumers — `src/spatialbench.ts:324` reads named fields only
  (`:331-334`); `test/distribution-adoption.mjs:801-817` asserts per-field, never an exhaustive key
  set; outputSchema is `.passthrough()`. `final-prompts.log` 3/3 pass.
- `PerfDiagnoseRequest.device` is required (`src/perfcli.ts:361`), so `requestedDevice` is always a
  string and can never be an own-key `undefined`.
- Evidence-tree integrity: no `deleted file mode`, no `rename from`, no `--- a/evidence` in the diff;
  25 new files.
- Reported gate results spot-checked against the logs: bootstrap-freshness 30/30, buildfreshness
  26/26, sdkselection 177/177, doors 17 suites / 0 fail, picocli 22 suites / 0 fail, prompts 3/3. The
  `[warn]` strings in `final-lint.log` are lint-rule severity tiers, not run warnings.

### Assessment

**Task quality:** Needs fixes

**Reasoning:** The three required behaviors are implemented correctly, the gate is placed where it
cannot break an existing healthy checkout, and the disclosed `requestedDevice` deviation is the right
call for the right reason; but the provenance gate is bypassed for an existing-but-unreadable receipt
(`scripts/build-identity.mjs:249`) and the `selection` disclosure can name the wrong installation for
`editor` (`src/toolchainwatch.ts:33,65-67`) — two small, local fixes in exactly the property this task
exists to establish.
