# Task 1 review — fixture isolation, blank PICO_ADB, door seam (e1481ea..33ec6b8)

### Spec Compliance

- ✅ Spec compliant. Every brief item and both folded-in items are present in the diff and carry
  behavioural tests.
  - Unconditional fixture pin + single validated escape hatch: `scripts/gate-inventory.mjs:51`
    (`HARNESS_ADB_VARIABLE`), `:53-60` (`isExecutableFile`), `:72-89` (`gateChildEnv` — inherited
    value replaced, `native-contract` returned identical at `:73`, `GATE_FIXTURE_ADB_INVALID` thrown
    at `:76-83`).
  - Pre-spawn refusal with exit 2 and the fix on stderr: `scripts/run-gate.mjs:184-190`; proven live
    in `evidence/…/task-1/step4-green-gate-inventory.log` (`# exit=2`, nothing spawned).
  - `gates.yml` workflow env byte-identical: only the comment block above `env:` changed
    (`.github/workflows/gates.yml` hunk); the pinning test at `test/gate-inventory.mjs:538`
    (`^env:\n  PICO_ADB: /fixture/no/such/adb`) still matches and passes 46/46.
  - Blank `PICO_ADB` → `override-rejected` "is set but empty", nothing probed: `src/adb.ts:71-77`
    (`classifyAdbOverride`), `:152-156` (`pick()` blank branch, `probed` stays `[]`), message still
    names a set variable via `src/adb.ts:81-83`.
  - Door seam: `src/doors.ts:387-389` (presence of `dependencies`, not of a lane, decides fixture),
    `:390-398` (`seamError`), `:399-412` (both lanes refuse on a fixture). Nine handlers converted to
    `const call = await doorCall();`.
  - Exactly three `await inner()` sites: verified independently of the test's regex — `grep -n
    "inner(" src/doors.ts` returns the definition at `src/doors.ts:310` plus `:356` (`innerCall`),
    `:404` (`doorCall` fallback), `:411` (`doorCallRaw` fallback). **Named risk checked** (seam could
    be bypassed through the exported `innerCall()`): no door handler references it — the only
    `innerCall` consumer is `src/spatialbench.ts:302`.
  - Folded item (a): `src/preflight.ts:241-242` (`declaredAdbOverride` returns the adapter's
    classification), `:257-263` (`adbCandidates` yields `[]` for blank), `:374-380` (blank row fails
    with the adapter's reason and an "Unset PICO_ADB" fix). Emulator row consequence proven by
    `test/preflight.mjs:651-694` (zero `version` probes, zero argv containing `devices`, emulator row
    `unknown`), green in `fold-green-preflight.log`.
  - Folded item (b): `src/nativefleetreceipt.ts:426-433` (`resolveAdbPath` → `adbExecutable()`,
    injected `deps.adbPath` still wins), `:446-458` (resolution moved inside the fail-closed `try`).
  - AGENTS.md sentence is true against the code (each clause checked above), sits in the
    "One inventory owns every gate command" gotcha far outside the pico-cli policy markers, and
    `test:distribution-adoption` passed 43/43 on that text (`gate-distribution-adoption.log`).
  - `evidence/` additions only — every evidence entry in the diffstat is a new file with no deletions.
- ⚠️ Cannot verify from this diff: the `Co-Authored-By: Claude Fable 5.1` trailer on all four commits
  (the diff package lists subjects only, and I was asked not to run git). Controller should confirm
  with `git log -4 --format='%H%n%(trailers:key=Co-Authored-By)'`.
- ⚠️ Cannot verify from this diff: gates other than `preflight`/`runreceipt`/`sdkselection` were not
  re-run after the fold commit `33ec6b8`. I checked the exposure myself rather than leaving it open —
  see Minor 1; it is low, but no log covers the final tree for `test:doors`, `test:lint`,
  `test:docsmeta`, `test:distribution-adoption`, `test:picocli`.

### Strengths

- The pin is now a property of `run-gate`, not of the operator's shell, and the caller's env object
  is still never written (`test/gate-inventory.mjs:429` and `:463` assert the caller object per value).
- One rule, one home. `classifyAdbOverride` / `describeAdbOverrideRejection` (`src/adb.ts:60-83`)
  mean the doctor and the adapter cannot drift; `src/preflight.ts:241-242` is a single delegation
  rather than a second trim. The `""` formatting lives in exactly one place.
- The seam fix targets the right invariant: `dependencies` *presence* decides, so `{}` is a fixture.
  That is what makes the nine converted doors unable to regress quietly.
- `test/doors.mjs:295-297` asserts the bare fixture's registered tool set equals the driven set, so a
  future door without minimal args fails loudly instead of being skipped — the failure mode most
  "iterate over all tools" tests get wrong.
- Tests exercise real behaviour, not mocks: real executable temp files for the harness override
  (`test/gate-inventory.mjs:481-489`), a real in-memory MCP client/server pair for all 16 doors,
  recorded `exec` argv for the doctor rows, and `fixture.events []` / `receiptFiles []` assertions
  proving the producer spawned nothing.
- TDD evidence is genuine and specific, not a ritual: `step9-red-doors.log` shows 14/16 doors
  answering from a real inner server and `doors.ts has 12 inner() sites`; `fold-red-preflight.log`
  shows `adb devices ran behind a blank PICO_ADB` with the actual argv. Logs are clean — I grepped
  all 21 for `Warning|deprecat|UnhandledPromise|MaxListeners` and found none.
- Hermeticity of the RED runs is itself evidenced (stub adb, scratch `HOME`, `PICO_MCP_CLI_POLICY=
  disabled`, and a PATH tripwire reporting 0 invocations), and the residual inner-server spawn was
  disclosed rather than hidden.

### Issues

#### Critical (Must Fix)
None.

#### Important (Should Fix)
None.

#### Minor (Nice to Have)

1. **Post-fold gates unverified on the final tree.** The fold changed `src/adb.ts`, `src/preflight.ts`,
   `src/nativefleetreceipt.ts`, but only `test:preflight`, `test:runreceipt`, `test:sdkselection` were
   re-run. **Named risk checked** (the adb classifier is now shared by three consumers): every other
   suite importing the changed modules feeds a non-blank value, so the blank-only behaviour change
   cannot reach them — `test/picocli.mjs:82` and `test/distribution-adoption.mjs:1862` inject
   `adbOverride: null`, `test/verifyapk-observation.mjs:33-34` pins a nonexistent absolute path,
   `test/toolchain-consumers.mjs:788,818` uses `null`/a real path and is inside the re-run
   `test:sdkselection`. Exposure is nil by inspection; re-running the battery on `33ec6b8` would
   close it by evidence.
2. **`src/nativefleetreceipt.ts:426-433` — the adapter branch is unreachable in production today, so
   the new `adb-resolution` stage is test-only.** `adbPath` is a *required* field of
   `NativeFleetReceiptDependencies` (`src/nativefleetreceipt.ts:63`), and the sole production caller
   passes it eagerly: `src/fleetbuild.ts:1243` `nativeRun: { adbPath: ADB() }` with
   `ADB = () => adbExecutable()` (`src/fleetbuild.ts:45`). A blank `PICO_ADB` therefore throws out of
   `ADB()` at the deps-construction site, *outside* the producer's fail-closed envelope, and never
   becomes the structured `adb-resolution` failure this change adds. The new test reaches the branch
   only by deleting a required property (`test/nativefleetreceipt.mjs:616`). The requirement is met
   and the latent string-read trap is genuinely removed, but the controller should know the
   user-visible refusal still comes from `fleetbuild.ts:1243`. I did not trace whether that throw is
   caught by an outer handler (one focused check per risk; it is pre-existing behaviour either way).
3. **`src/runrevisiontypes.ts:448` adds `adb-resolution` to a persisted `…V1` union.** I verified the
   report's claim rather than trusting it: no runtime validator enumerates these stages — the only
   stage allowlist is `parseExternalPhase` in `src/runlocks.ts:492-497`, which validates
   `ExternalPhaseV1`, a different union. Type-only change, safe.
4. **`test/doors.mjs:247-248` says "Ten doors used to call the shared inner client directly";
   `src/doors.ts:382` says "Nine".** The diff converts nine (`pico_ship` at the `@@ -627` hunk already
   used `doorCall()`), so the test comment is the wrong one. Fix the comment.
5. **`scripts/gate-inventory.mjs:72` — the `io = { isExecutableFile }` parameter is dead.** No caller
   passes it: `scripts/run-gate.mjs:185` calls `gateChildEnv(gate, env)` and every test calls it with
   two args, using real temp files instead. It is brief-mandated, and the tests are better for using
   real files, but the seam is untested indirection in a script that otherwise has none.
6. **The refusal messages state the same remedy twice.** `src/adb.ts:75` ends the reason with "unset
   PICO_ADB to use the PATH/bundled chain, or name an absolute executable", and `refuseOverride`
   (`src/adb.ts:143-150`) then appends "correct $PICO_ADB, or unset it to use PATH and the selected
   toolchain's bundled platform-tools". Same doubling in the doctor row: `src/preflight.ts:378`
   detail plus `:379` fix. One remedy per message reads better and keeps the row's `fix` field
   authoritative.
7. **`src/preflight.ts:371-388` is now a four-way nested ternary inside a `push(...)` argument**
   (pass / blank / declared / none). It is correct, but it is the least readable block in a 566-line
   file; a small `adbRow()` helper returning the `CheckResult` would isolate it.
8. **`scripts/run-gate.mjs:184-190` handles its third pre-spawn refusal differently from the other
   two** — unknown gate and stale build throw, this one writes to `process.stderr` directly and
   returns 2, which forces `test/gate-inventory.mjs:515-537` to monkey-patch `process.stderr.write` to
   assert it. Plan-mandated by the brief (Step 3) and documented at `scripts/run-gate.mjs:146-148`,
   so keep it; noting the asymmetry for whoever adds the fourth.
9. **Coverage gap in the override validator: an existing non-executable regular file.** The invalid
   list (`test/gate-inventory.mjs:491-496`) covers relative, nonexistent, a directory, `""` and
   `"   "`. Both `isExecutableFile` branches are hit (the directory covers `isFile()`, the
   nonexistent path covers `accessSync`), but the "file exists, no +x" case — the likeliest real
   mistake — is not asserted.
10. **Nothing checks that the harness override is actually a fake.** `PICO_GATE_FIXTURE_ADB=
    /opt/homebrew/bin/adb` validates and hands a real adb to every fixture and installed-artifact gate
    child (`scripts/gate-inventory.mjs:84`). The spec defines the hatch exactly this way, so this is a
    design note, not a violation — but the variable's name and the fix text ("point it at an
    executable fake") are the only thing standing between the hatch and the hazard the pin exists to
    remove.
11. **`CHANGELOG.md:82-83` now documents behaviour that no longer exists** ("every
    fixture/installed-artifact gate child runs under `PICO_ADB=/fixture/no/such/adb` unless the caller
    set one"), and it sits under the `## 38.0.0 — 2026-09-15` heading, not `## Unreleased`. Since the
    version stays 38.0.0, that entry describes what 38.0.0 ships — and it is now false. The
    implementer disclosed this (report concern 3) and the brief scoped docs to AGENTS.md; the
    controller should make sure Task 6 fixes the CHANGELOG entry, not only the checkpoint
    (`docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md:74,144,659`, which is a historical record and
    may legitimately stay).
12. **`registerDoorTools(server, null)` would silently take the production path** (`src/doors.ts:387`
    tests truthiness). TypeScript forbids it (`dependencies?: DoorToolDependencies`), and no call site
    does it — `src/index.ts:395` passes nothing, `test/vault.mjs:60,445` pass one argument,
    `test/doors.mjs:116,213,288,359` pass objects — so this is theoretical. `dependencies !== undefined`
    would close it for free.

### Assessment

**Task quality:** Approved

**Reasoning:** All brief items and both folded-in requirements are implemented at the right layer —
one shared classifier instead of a second copy of the blank rule, a seam that keys on the presence of
`dependencies` rather than of a lane, and a pin that is applied rather than inherited — with RED/GREEN
evidence that matches the code and clean test output. Everything I found is comment drift, message
polish, or disclosed follow-up work; nothing makes the task untrustworthy.
