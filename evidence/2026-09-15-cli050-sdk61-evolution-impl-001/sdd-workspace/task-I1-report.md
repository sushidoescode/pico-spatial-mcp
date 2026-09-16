# Task I1 — register the merged tracks' suites, ship the SDK compatibility payload, wire the cross-track tarball canaries

**Status: DONE_WITH_BLOCKER.** Every brief item is implemented and its covering gate is green.
One acceptance line is NOT met and cannot be met inside this task's ownership:
`npm run test:tarball` is still RED, on a **different, newly-exposed** check —
`FAIL absolute home paths leak in: data/sdk-compatibility/basis/sdk-6.0.0-drift.md
(/Users/sushantsrikrish)`. The remedy is four files, none of them mine; I measured it end-to-end
(gate → `Failures: 0`), then reverted it so the controller decides. Details in **Blocker** below.

Commit: `f88a7d0` `chore: register merged suites and ship the SDK compatibility payload`
(branch `cli050-sdk61-evolution-2026-09-15`, parent `23a075c`, never pushed, tree clean).

---

## What changed

### 1. `test:sdkselection` — the six SDK-track suites as ONE Linux `fixture` gate

`scripts/gate-inventory.mjs` gains one entry, `package.json` the one-line dispatcher
(`node scripts/run-gate.mjs test:sdkselection`), `.github/workflows/gates.yml` the step
`SDK/toolchain selection (resolution, consumers, project identity, cache, declaration context)`
in the Linux `gates:` job, placed after `test:runrevision`. Argv is exactly S6's Handoff C list:

```
node --test test/toolchain-resolution.mjs test/toolchain-consumers.mjs test/projectidentity.mjs \
             test/toolchain-cache.mjs test/declarationcontext.mjs test/declarationcontext-installed.mjs
```

Scope is `fixture` (not `installed-artifact`): `declarationcontext-installed.mjs` copies the built
`dist/` into a relocated package and spawns it, so it must have current output —
`run-gate`'s staleness refusal covers `fixture`, which is what that suite needs.

**Resolution 1 — Linux only, and why.** The inventory's own contract forbids the Windows option:
`validateGateInventory` pushes `"<name> is invoked more than once: <jobs>"` whenever a gate name
appears in more than one workflow lane (`scripts/gate-inventory.mjs`, the `where.length > 1`
branch), and `scripts/gate-inventory.mjs`'s header states it outright — *"host — the CI lane that
owns the gate. Exactly one; a gate is never run twice."* So "also add it to the Windows lane" is
structurally impossible for this gate name; it would require a second gate (`test:sdkselection-win`
or similar), which the brief's "as ONE Linux `fixture` gate" did not authorise. Adding it anyway
would have made `validateGateInventory` non-empty and failed the stated acceptance.

Two secondary observations, since the resolution asked me to look at the source either way:
the suites *are* substantially platform-neutral — `toolchain-resolution`, `toolchain-cache` and
`toolchain-consumers` drive `toolchainIOFromTree({platform: "darwin"|"linux"|"win32", …})` with
explicit platforms against in-memory trees, and `projectidentity` uses `mkdtemp` temp projects
(including a `projectidentity é ` hostile-path case). But they are not *purely* neutral:
`test/toolchain-cache.mjs:260` writes a `#!/bin/sh` fixture binary with `mode: 0o755` (a POSIX
executable-bit probe), and `test/declarationcontext-installed.mjs` `cpSync`s `dist/` and
`spawnSync`s `process.execPath`. Neither is known-broken on Windows; neither has been *run* there.
I make no cross-platform claim for them.

### 2. `test/cliobservations.mjs` (C3) and `test/innerclient.mjs` (C5) — no new gate names

- `test:picocli` commands: `[["node","test/picocli.mjs"], ["node","--test","test/picocli-autoinstall.mjs","test/picocli-sweep.mjs"], ["node","--test","test/cliobservations.mjs"]]`
- `test:doors` commands: `[["node","test/doors.mjs"], ["node","--test","test/innerclient.mjs"]]`

Each appended as its own argv array, matching the inventory's "one array per `&&` segment"
convention. Counts move by zero for these two, as C3/C5 intended.

**One ownership deviation, disclosed.** `test/gate-inventory.mjs:145` pins
`GATES["test:picocli"].commands` with a literal `deepEqual` of exactly two argv arrays, so
appending the C3 suite *necessarily* breaks it. I added the third array to that literal and changed
nothing else in that file (1 line added, 0 removed). `test:doors` is not pinned there, so it needed
no test edit. This is the same class as the `test/distribution-adoption.mjs` clause in my
ownership ("only if a derived expectation genuinely needs a code change") applied to the file that
actually holds the expectation; `test/distribution-adoption.mjs` itself needed **no** change,
because R3/R4 already made every count in it derived.

### 3. `package.json` `files[]` — `"data/sdk-compatibility"` immediately after `"dist"`

Exactly S6's Handoff A. Not `"data"`, not `docs/`, not `test/`. Ships 3 files:
`index.v1.json`, `basis/sdk-6.0.0-drift.md`, `basis/sdk-adoption-provenance.json`.
This also closes the `[M1]` sibling check — `derivedSiblingDirs()` derives `data` from the built
`dist/`, and `payload present: data/` now passes.

### 4. `scripts/verify-tarball.mjs` `[M10]` — the installed SDK-payload canary

S6's Handoff B code verbatim, inserted immediately after the `[M1]` sibling loop and before the
`// [M2] Content, not just a directory.` comment, with one deviation S6 itself pre-authorised:
**the marker is `[M10]`, not `[M6]`.** `[M6]` was already taken twice in that file (the hostile
sandbox name, and the doors round-trip), so per S6's own note I used the next free number and added
the one-line summary to the header's `[Mn]` list. It `await import`s
`<installedRoot>/scripts/verify-sdk-compatibility-payload.mjs` — the INSTALLED copy, never the
checkout's — through `pathToFileURL` (the sandbox path has a space and a non-ASCII character), and
passes `installed` as `packageRoot`. `payload.ok === false` fails the gate and lists
`payload.errors.slice(0, 3)`; an import/throw is its own `fail`. Resolution 2 satisfied.

`scripts/sync-metadata.mjs`'s two text hooks into this file are untouched: `const EXPECTED_TOOLS =
255;` keeps its exact spelling, and the `// core lanes` comment inside `REQUIRED_TOOLS` did not
move.

### 5. `scripts/verify-tarball.mjs` `[M11]` — the two C5 doors assertions, against the installed artifact

Inserted after the `[M6]` doors block and before `[M7]`. Hermetic exactly like `test/doors.mjs`'s
end-to-end case (resolution 3), with the fixture built **inside the existing `sandbox`** — see
"Constraint I had to design around" below:

- fixture `HOME`/`USERPROFILE`, `PICO_HOME` pointed at an absent directory;
- `PATH` = `[fixtureBin, dirname(process.execPath)]`, mirroring `createManagedRuntimeHarness`;
- a `node` proxy in `fixtureBin` that appends its joined argv to a log and then
  `exec`s the real node. `src/doors.ts:281` spawns the inner child as `command: "node"` resolved
  through `PATH`, so **one logged line ending in `dist/index.js` is one inner child** — the same
  counting method `test/doors.mjs:775` uses through the harness's node-proxy call log;
- an `npm` that refuses every call (exit 2) and `PICO_MCP_CLI_POLICY: "disabled"`, so nothing in
  this check can reach a registry or provision anything;
- `$PICO_ADB` at an `exit 1` stub that appends every argv it receives to a marker file, plus the
  C5 fix-round guard: `accessSync(X_OK)` + `statSync().isFile()` immediately before `pico_look`,
  and the call is **not made** if that fails (capture resolves `$PICO_ADB` by existence first and
  would otherwise fall through to a real adb).

The two checks:

1. **single-flight** — 20 concurrent `pico_sdk` first calls (`Promise.allSettled`, so a protocol
   rejection is reported rather than throwing out of the gate) must leave `innerChildren() === 1`
   and all statuses equal and not `"error"`.
2. **`isError`, never laundered** — `pico_look` must return `isError === true`, text matching
   `/screencap failed/`, **no** `"status": "ok"` wrapper, still exactly one inner child, and the
   adb marker must contain an `exec-out screencap` argv (proof the stub ran, not merely that the
   words appeared).

`process.platform === "win32"` takes a labelled `skip()` — the stubs are POSIX shell and
`test:tarball` is a Linux gate. Nothing here touches a real adb, device, emulator or registry.

**Constraint I had to design around:** `test/publish-tarball.mjs:300` asserts that the *only*
`rmSync` argument anywhere in `verify-tarball.mjs` is `sandbox`. So I could not call
`createManagedRuntimeHarness()` (it `mkdtemp`s its own root under `os.tmpdir()` and the caller is
expected to remove it) without either leaking a temp tree or adding a forbidden second `rmSync`.
I reused the *conventions* instead and rooted the fixture at `<sandbox>/doors fixture`, so the one
`rmSync` this script already owns cleans it. A second reason not to import the helper: `scripts/`
ships in the tarball, and `test/` does not — an import of `../test/helpers/…` would put an
unresolvable specifier into a published file.

### 6. Derived doc counts — regenerated, not typed

Generated by a one-shot script from `gateInventoryCounts()` (R3's mechanism); the script asserted
exactly one match per document before writing.

| File | Before | After |
| --- | --- | --- |
| `README.md:341` | `53 gate invocations (52 \`test:\` suites plus \`smoke\`). CI assigns 50 to` | `54 gate invocations (53 \`test:\` suites plus \`smoke\`). CI assigns 51 to` |
| `docs/COLLABORATORS.md:15` | `the deterministic gate battery, 53 gate invocations (52 \`test:\` suites plus \`smoke\`):` | `…54 gate invocations (53 \`test:\` suites plus \`smoke\`):` |
| `AGENTS.md:24` | `61 of the 85 \`test/*.mjs\` files` | `68 of the 95 \`test/*.mjs\` files` |

`gateInventoryCounts()` before → after: `{invocations: 53→54, suites: 52→53, hosts: {linux 50→51,
windows 1, macos 2}}`. README's host breakdown is itself asserted (derived) by
`test/distribution-adoption.mjs`'s `spelled()` regex, which is why the `50 → 51` had to move too.

`AGENTS.md:24` re-measured with the command the sentence publishes:

```
$ ls test/*.mjs | wc -l                                                    #  95
$ grep -lE '(from|import\()[[:space:]]*"\.\./dist/' test/*.mjs | wc -l     #  68
```

**AGENTS.md's gate paragraph needed no edit.** R3 deliberately rewrote *"One inventory owns every
gate command and its CI lane"* to state the shape and carry no number, so adding a gate leaves it
correct. No hardcoded number was introduced anywhere (resolution 4).

---

## Gates added and derived counts

| Gate | Host | Scope | Lane step | Counts moved |
| --- | --- | --- | --- | --- |
| `test:sdkselection` (new) | linux | fixture | `SDK/toolchain selection (…)` | invocations 53→54, suites 52→53, linux 50→51 |
| `test:picocli` (extended) | linux | fixture | unchanged | none |
| `test:doors` (extended) | linux | fixture | unchanged | none |

Not registered, as instructed: `test/artifactinspection.mjs`, `test/verifyapk-observation.mjs`
(C6 has not merged).

---

## Tarball result — before and after

**Before** (HEAD `23a075c`, recorded by the merge checks at 13:25 today,
`evidence/2026-09-15-cli050-sdk61-evolution-impl-001/merge-checks/release-merge-suites/test_tarball.log`):
exactly one FAIL, `grep -c FAIL` = 1.

```
  FAIL payload MISSING: data/ — the built code resolves it
Tarball verification done. Failures: 1
```

**After** (`evidence/…/task-I1/test-tarball-after.log`): the missing-payload FAIL is gone, all
three new checks pass, and one *different* check fails.

```
  ok   payload present: data/
  ok   reviewed SDK-compatibility payload verified (3 files, index + every referenced record/basis)
  FAIL absolute home paths leak in: data/sdk-compatibility/basis/sdk-6.0.0-drift.md (/Users/sushantsrikrish)
  ok   20 concurrent first door calls on the installed artifact started exactly one inner server (all unavailable)
  ok   installed pico_look forwards the inner screencap failure as isError, never as status ok (stub adb ran: 1 invocation(s), screencap argv recorded)
Tarball verification done. Failures: 1
```

The `[M10]` canary and both `[M11]` assertions are present and passing against the installed
artifact. `(all unavailable)` is the expected status under a fixture `HOME` with no agent vault —
the same status `test/doors.mjs`'s cold case and `[M6]` already accept.

---

## BLOCKER — the S6 basis snapshot cannot ship past `[M4]`

`data/sdk-compatibility/basis/sdk-6.0.0-drift.md` contains **12 occurrences** of
`/Users/sushantsrikrish` (a `~/.gradle/caches/modules-2/files-2.1/…` cache root, inside shell and
Python transcripts). `[M4]` byte-scans every shipped file for `/Users/<name>` and fails — that is
precisely the defect class `[M4]` exists for, and it was invisible until now because the gate was
already red for the missing-directory reason and S6 deliberately did not run it.

The other two payload files are clean (`grep -c` = 0 for both `index.v1.json` and
`basis/sdk-adoption-provenance.json`). So this is one file, one unique string.

Why I could not just drop `basis/` from the package: it is **load-bearing at runtime**, not
provenance. `src/declarationcontext.ts:686` reads the basis bytes and re-hashes them, and an
`evidence-hash` mismatch is a declaration-authority failure; and the `[M10]` canary (S6's own
script) verifies every file the index declares, `historicalReferences` included.

Why I could not redact it: the four files that would have to change are **all outside this task's
ownership**, and two of them are protected by explicit global constraints.

- `docs/SDK_6_0_0_DRIFT.md` — the original; global constraint *"Preserve original evidence bytes"*.
- `data/sdk-compatibility/basis/sdk-6.0.0-drift.md` — S6-owned, and
  `test/declarationcontext.mjs:253` asserts it is a **byte copy** of the docs page.
- `data/sdk-compatibility/index.v1.json` — S6-owned; it pins the sha256.
- `test/declarationcontext.mjs:267` — hardcodes `e1671fbdaf1ee27…`; editing it is *"a test suite's
  assertion other than a count derivation"*, explicitly forbidden to me.

**Measured remedy, then reverted.** I applied `/Users/sushantsrikrish` → `$HOME` (12 sites) to
`docs/SDK_6_0_0_DRIFT.md`, re-copied it to the basis path, re-pinned the sha256 in
`index.v1.json` and in `test/declarationcontext.mjs:267`, rebuilt, and ran both affected gates:

```
new basis sha256: 4867469dc576a6fec2eaa81f27d3dff388787db18d62b2b681bc2f1b92148bda
node --test test/declarationcontext.mjs   →  tests 25  pass 25  fail 0
npm run test:tarball                      →  Tarball verification done. Failures: 0
                                             ok  no absolute home paths in any shipped file
```

(Logs: `evidence/…/task-I1/redaction-experiment-declarationcontext.log`,
`…/redaction-experiment-tarball.log`.) I then `git checkout --`'d all four files; the basis file
hashes back to `e1671fbdaf1ee27…` and the docs page carries its 12 original occurrences again.
**No evidence byte was changed in the committed state.**

`$HOME` is a proposal, not a decision — it keeps the shell lines runnable but leaves the two
`Path('…')` Python lines needing `Path.home()/…` if the controller wants them literally runnable.
Alternatives the controller may prefer: redact only the `data/` copy and relax the
byte-copy assertion at `test/declarationcontext.mjs:253`; or keep the drift snapshot out of the
reviewed index entirely. I did **not** consider relaxing `[M4]` a real option.

---

## Verification run (all host-local; no emulator, device, MCP tool or network beyond `npm pack`/`install`)

| Command | Result |
| --- | --- |
| `npm run build` | `published 189 file(s) for source 1697eef568fa` |
| `node --test test/gate-inventory.mjs` | tests 31, pass 31, fail 0 |
| `npm run test:lint` | `Failures: 0` + `published gate-battery size agrees … (54 invocations / 53 test: suites; linux 51, windows 1, macos 2)` |
| `npm run test:distribution-adoption` | tests 43, **pass 43**, fail 0 (was 41/43 before this task — the two red ones were the inventory counts) |
| `npm run test:docsmeta` | `Failures: 0`; tests 26, pass 26, fail 0 |
| `node scripts/run-gate.mjs test:sdkselection` | tests 173, pass 173, fail 0 |
| `npm run test:picocli` | `Failures: 0`; 157/157 + **21/21** (`cliobservations`) |
| `npm run test:doors` | `Failures: 0`; **17/17** (`innerclient`) |
| `npm run test:tarball` | **Failures: 1** — the `[M4]` leak above; every I1-added check passes |

Note for whoever runs these next: `run-gate` refuses a stale `dist/`, and the build receipt binds
`scripts/` too — editing `scripts/gate-inventory.mjs` invalidated the build I had just made
(`afdeea9b2616 → 1697eef568fa`). **Rebuild after script edits, not just after `src/` edits.**

---

## Files changed (commit `f88a7d0`, 8 files, +146 / −5)

| File | Why |
| --- | --- |
| `scripts/gate-inventory.mjs` | +`test:sdkselection`; `test:picocli` +1 argv; `test:doors` +1 argv |
| `package.json` | `files[]` +`data/sdk-compatibility`; +`test:sdkselection` dispatcher |
| `.github/workflows/gates.yml` | +1 Linux step for `test:sdkselection` |
| `scripts/verify-tarball.mjs` | `[M10]` payload canary, `[M11]` doors failure/concurrency checks, 2 header lines |
| `test/gate-inventory.mjs` | `test:picocli` pinned command list +1 array (forced; disclosed) |
| `README.md` | derived count line |
| `docs/COLLABORATORS.md` | derived count line |
| `AGENTS.md` | re-measured test-file sentence |

Untracked, not committed: `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/task-I1/*.log`
(`.gitignore:3` ignores `*.log`).

---

## Self-review

- **`validateGateInventory(package.json, gates.yml)` → `[]`** — run directly, printed `[]`.
  Every registered gate has exactly one lane whose runner OS matches its host
  (`linux 51 / windows 1 / macos 2`, windows = `["test:picocli-win"]`, macos = the two CMIO
  contracts, unchanged).
- **Every new suite runs in a CI lane** — `test:sdkselection` in the Linux `gates:` job;
  `cliobservations` inside `test:picocli`; `innerclient` inside `test:doors`. Confirmed by running
  each gate, not by reading the YAML: the picocli log shows a second `21/21` block and the doors log
  a `17/17` block that were absent before.
- **The tarball carries and verifies `data/sdk-compatibility`** — `payload present: data/` and
  `reviewed SDK-compatibility payload verified (3 files, index + every referenced record/basis)`,
  from the INSTALLED copy of the canary, against the extracted root.
- **No policy block byte changed** — the three doc diffs are one line each, all count lines, all far
  above the `pico-mcp-managed-cli-policy` markers; `test/distribution-adoption.mjs`'s canonical
  block test and its vocabulary guard both pass (43/43). I wrote `PICO_MCP_CLI_POLICY: "disabled"`
  only in `scripts/verify-tarball.mjs`, which that guard does not scan (it scans exactly
  README/GETTING_STARTED/SKILLS/AGENTS/TESTERS/docs/HOSTS).
- **Prior evidence untouched** — the redaction experiment was fully reverted and re-verified by
  digest; `git status` shows only the pre-existing untracked evidence dirs plus my own log dir.
- **`rmSync`/`copyFileSync` invariants held** — `test/publish-tarball.mjs` (11/11 inside
  `test:tarball`) still sees `sandbox` as the sole `rmSync` argument and no `copyFileSync`.
- **`sync-metadata` hooks intact** — `const EXPECTED_TOOLS = 255;` spelling and the `// core lanes`
  comment position unchanged; `test:docsmeta` (which shells `sync-metadata --check`) is green.

## Concerns

1. **The blocker above is the only thing between this branch and a green `test:tarball`.** It needs
   a controller decision on four files I do not own. The fix is mechanical and measured; resuming me
   with authority over those four files closes it in minutes.
2. **`test/gate-inventory.mjs` was edited** (1 line) because appending to `test:picocli` could not
   be done otherwise. If the controller would rather that literal not move, the alternative is to
   give `test/cliobservations.mjs` its own gate name — which *does* move every derived count again.
3. **`[M11]`'s `(all unavailable)` is a fixture-HOME artefact, not a vault-backed answer.** It
   proves single-flight and transport shape; it does not exercise a vault hit. `[M6]` already
   records the same limitation for its own round trip.
4. **`[M11]` skips on Windows** and has only been executed on darwin here. `test:tarball` is a Linux
   gate, so its first real lane run will be Linux CI; I have no Linux measurement of it.
5. **`test:sdkselection` has never run on Windows.** I state no cross-platform claim for those six
   suites — only that their fixtures pass explicit platforms and that two of them carry POSIX-shaped
   filesystem fixtures and a child spawn.
6. **Nothing here is visual, native or device evidence.** Everything above is host-local
   structural/fixture evidence plus one installed-artifact lane. No emulator, device, MCP tool or
   `pico-cli` operation was touched, and no LOOK was performed or claimed.

---

# Continuation — controller ruling on the `[M4]` blocker

**Status: DONE.** `npm run test:tarball` is now fully green (`Failures: 0`). Commit `af8ce54`
`fix: package a home-path-redacted SDK compatibility basis with recorded provenance`
(7 files, +255/−27, parent `f88a7d0`, never pushed).

## The two hashes

| | path | sha256 |
| --- | --- | --- |
| original — **untouched, not shipped** | `docs/SDK_6_0_0_DRIFT.md` | `e1671fbdaf1ee278298258f4aa3c5771861a677e37e22e8281d0ffc7eb7d6b5a` |
| packaged derivative — **shipped** | `data/sdk-compatibility/basis/sdk-6.0.0-drift.md` | `4867469dc576a6fec2eaa81f27d3dff388787db18d62b2b681bc2f1b92148bda` |

`docs/SDK_6_0_0_DRIFT.md` was not edited: `git diff --stat docs/` is empty and the file still
digests to `e1671fbd…`, still carrying its 12 original `/Users/…` transcripts. The old pin
`e1671fbd…` did not disappear — it moved into `derivedFrom.sha256`, so the original's identity is
still asserted, now as provenance rather than as the packaged bytes.

## The transform, and one deviation from the ruling's literal wording

```js
packaged = original.replace(/\/Users\/[A-Za-z0-9._-]+/g, () => "$HOME")   // 12 occurrences, nothing else
```

The ruling specified `pattern: "/Users/sushantsrikrish"`. **I did not use that literal**, because
`index.v1.json` is itself a shipped file: recording the literal there would have put the home
directory name straight back into the package and left `[M4]` red — the exact failure being fixed.
The recorded pattern is the non-naming character class `/Users/[A-Za-z0-9._-]+`, which

- produces **byte-identical** output on this document (digest `4867469d…` — the same value my
  pre-ruling experiment produced from the literal replacement, so the two are equivalent here), and
- does **not** itself match `[M4]`'s regex, verified directly:
  `LEAK_RE.test("/Users/[A-Za-z0-9._-]+")` → `false` (the character after `/Users/` is `[`, which
  is outside `[A-Za-z0-9._-]`).

The concrete host name that was redacted (`sushantsrikrish`) is recorded in the appended, un-shipped
`evidence/…/sdk61-selection/REVIEW.md` note instead of in the payload. Everything else in the
ruling is implemented exactly as written.

**`sdk-adoption-provenance.json` is byte-identical and untouched — confirmed by grep**, using
`[M4]`'s own three alternations:

```
$ grep -cE '(/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+|[A-Z]:\\Users\\[A-Za-z0-9._-]+)' \
       data/sdk-compatibility/index.v1.json                     # 0
       data/sdk-compatibility/basis/sdk-adoption-provenance.json # 0
$ node … walk data/sdk-compatibility with the exact [M4] LEAK_RE
[M4] leak scan over data/sdk-compatibility: CLEAN (0 hits)
```

## The index entry

```json
{
  "path": "basis/sdk-6.0.0-drift.md",
  "sha256": "4867469dc576a6fec2eaa81f27d3dff388787db18d62b2b681bc2f1b92148bda",
  "derivedFrom": {
    "path": "docs/SDK_6_0_0_DRIFT.md",
    "sha256": "e1671fbdaf1ee278298258f4aa3c5771861a677e37e22e8281d0ffc7eb7d6b5a",
    "transform": "home-path-redaction",
    "pattern": "/Users/[A-Za-z0-9._-]+",
    "replacement": "$HOME"
  }
}
```

## Schema widening — needed, and minimal

It **was** needed, in two places, and for the same reason: both
`src/declarationcontext.ts:fileIdentityList` and the canary's copy required
`Object.keys(entry).sort().join(",") === "path,sha256"` **exactly**, so the extra field would have
made the whole index `index-schema` unavailable.

`src/declarationcontext.ts` (the one pre-authorised `src/` change — additive, no behaviour change
for any existing index): a new pure `derivedFromProblem()` validator, `fileIdentityList` gains
`{ allowDerivedFrom = false }`, and exactly one call site opts in. Because the flag defaults to
`false`, `records`, a record's `basis`, `sourceFiles`, `artifacts` and `signatures` stay strictly
`{path, sha256}` — the tolerance cannot leak into a reviewed record. `scripts/verify-sdk-compatibility-payload.mjs`
mirrors it (the canary's banned-substring discipline is unaffected: no `child_process`,
`process.cwd`, `writeFileSync`, … was added).

**`derivedFrom` is validated and then dropped.** Neither the loader nor the canary resolves
`derivedFrom.path`: it names a file outside `data/sdk-compatibility/` that no installed package
contains, and exact-hash verification of the *packaged* bytes is unchanged. Re-deriving the
transform is the repository's job, and a repo test does exactly that.

## Tests changed and added

| Where | What |
| --- | --- |
| `test/declarationcontext.mjs` | the byte-copy assertion became "equals the original under the **recorded** transform" — it reads `derivedFrom` out of the real index, re-hashes `docs/SDK_6_0_0_DRIFT.md` against `derivedFrom.sha256`, re-derives the packaged bytes and compares, then asserts the entry is pinned at the packaged hash and **not** at the original's, and that the original still carries the home paths |
| `test/declarationcontext.mjs` | exact sha256 pin re-pinned to `4867469d…`; `e1671fbd…` re-asserted as `derivedFrom.sha256` |
| `test/declarationcontext.mjs` (new test) | no packaged compatibility file carries a home path (`[M4]`'s own regex over the whole data dir), the recorded pattern itself does not match that regex, a good `derivedFrom` loads and is dropped from the verified identity, six malformed shapes are refused as `index-schema`, and `derivedFrom` on a **record** is refused with a message that does not advertise the tolerance |
| `test/declarationcontext-installed.mjs` | the relocated-package test now also asserts the **installed** payload is leak-free, that exactly one basis is a recorded derivative, and that `derivedFrom.path` is genuinely **absent** from the installed package |

`test/fixtures/sdk-adoption-provenance.json` untouched; the provenance byte-copy assertion against
it is unchanged.

## Commands and output

```
$ npm run build                                      build-source: published 189 file(s) for source 43898bdcc3bd
$ node --test test/declarationcontext.mjs test/declarationcontext-installed.mjs
                                                     tests 34   pass 34   fail 0
$ node scripts/run-gate.mjs test:sdkselection        tests 174  pass 174  fail 0
$ npm run test:tarball                               Tarball verification done. Failures: 0
    ok   payload present: data/
    ok   reviewed SDK-compatibility payload verified (3 files, index + every referenced record/basis)
    ok   no absolute home paths in any shipped file
    ok   20 concurrent first door calls on the installed artifact started exactly one inner server (all unavailable)
    ok   installed pico_look forwards the inner screencap failure as isError, never as status ok (stub adb ran: 1 invocation(s), screencap argv recorded)
$ npm run test:docsmeta                              Failures: 0;  tests 26  pass 26  fail 0
$ npm run test:distribution-adoption                 tests 43   pass 43   fail 0
```

Suite totals moved as expected: `declarationcontext` 25 → 26 (one new test),
`test:sdkselection` 173 → 174, `declarationcontext-installed` 8 → 8 (**unchanged and green — the
backwards-compatibility proof for the schema widening**).

Not in the controller's list, run anyway because a `src/` change touches the loader's consumers
(`src/vault.ts`, `src/vaultdiff.ts` import it):

```
test:vault  Failures: 0    test:vaultdiff  Failures: 0    test:lint  Failures: 0    test:doors  Failures: 0
```

I also re-grepped for the old pin: `e1671fbd…` now appears in exactly two places, both intentional —
`index.v1.json`'s `derivedFrom.sha256` and the test line that asserts it.

## Files changed (commit `af8ce54`)

`data/sdk-compatibility/basis/sdk-6.0.0-drift.md` (12 lines redacted),
`data/sdk-compatibility/index.v1.json`, `src/declarationcontext.ts`,
`scripts/verify-sdk-compatibility-payload.mjs`, `test/declarationcontext.mjs`,
`test/declarationcontext-installed.mjs`, and an appended section in
`evidence/2026-09-15-cli050-sdk61-evolution-impl-001/sdk61-selection/REVIEW.md`.
`git diff --stat docs/` and `git diff --stat test/fixtures/` are both empty.

## Concerns

1. **The pattern deviation above is the one judgement call**; if the controller wants the literal
   host name recorded in the payload after all, `[M4]` must be given a scoped exemption instead,
   and I would argue against that.
2. **`$HOME` is not a literal drop-in for two Python lines** in the redacted document
   (`root = Path('$HOME/.gradle/…')` will not expand). Every measured fact — artifact coordinates,
   the two core binary SHA-256s, findings — is preserved and still asserted, but a reader
   re-running those two snippets verbatim from the *packaged* copy must substitute their own home.
   The un-redacted original in `docs/` remains exact.
3. **`derivedFrom` is repo-verifiable only.** An installed package cannot re-derive the transform
   (the original does not ship), so on the installed side the guarantee stays exact-hash on the
   packaged bytes. That is deliberate and is what the new installed-side assertion pins.
4. Everything above is host-local structural/fixture evidence plus the installed-artifact lane.
   No emulator, device, MCP tool or `pico-cli` operation; no LOOK performed or claimed.
