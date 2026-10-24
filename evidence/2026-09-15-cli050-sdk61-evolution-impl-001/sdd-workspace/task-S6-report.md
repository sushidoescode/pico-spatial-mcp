# Task S6 — Seal the static compatibility boundary and hand off runtime checks

Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-sdk-2026-09-15` (branch `track/cli050-sdk`)
Base: `89ee9d02d1df8e65425f29bcf4ab16037deeb24f` (S1–S5 complete and reviewed). Not pushed.
Commit: `30cfb12` — `test: cover mixed SDK selection and declaration provenance`, trailer verified.

Status: **DONE_WITH_CONCERNS** — every brief checkbox and all five controller resolutions are
implemented, tested and committed. The concerns are disclosures, not unfinished work: one
pre-existing deferred S4 item is now pinned rather than fixed (S6 may not touch `src/`), and
`target-compatible` remains unreachable through any tool surface by S5's design.

**No `src/**` file, `package.json`, `scripts/verify-tarball.mjs`, `.gitignore`, `.github/**`,
`test/distribution-adoption.mjs`, `test/helpers/**` or any policy document was changed.**
`git diff HEAD~1 -- src/ package.json scripts/verify-tarball.mjs` is empty.

| File | Change |
| --- | --- |
| `test/declarationcontext.mjs` | +154 (§7: combined fixture + CLI boundary) |
| `test/toolchain-consumers.mjs` | +419 (the operation matrix) |
| `scripts/verify-sdk-compatibility-payload.mjs` | new, 204 lines |
| `test/declarationcontext-installed.mjs` | new, 402 lines |
| `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/sdk61-selection/REVIEW.md` | new, 146 lines |

---

## What I implemented

### 1. Combined fixture (brief bullet 1, resolution 1) — `test/declarationcontext.mjs` §7

`combined fixture: selected tools 6.1, project BOM 6.0.0, vault revision 0.13.3 and a dynamic-BOM
project are four independent facts`.

One host, four version facts, each read from its own bytes:

| Fact | Source | Value |
| --- | --- | --- |
| selected tools | `resolveToolchain` over a `macSdkTree` fixture carrying 6.0 **and** 6.1 | `6.1` |
| project A declared BOM | `readProjectSdkIdentity` on a temp project in the skeleton catalog form | `6.0.0`, status `declared` |
| project B declared BOM | same, with `bom = "6.0.+"` | `null`, status `unknown` — a dynamic version is never rounded to a literal |
| vault package revision | `readDeclarationIdentity` on the fixture vault | `0.13.3`, authority `declarations` |

Asserted: the three version strings are pairwise distinct (`new Set(...).size === 3`) so no two
could have been inferred from each other; the packaged index lists **no** records, so
`resolveDeclarationContext` is `unknown` for both projects (and `historical` with no project at
all), with empty `evidencePaths`/`verifiedSymbols`; **no target authority without matching
evidence** is proven in both refusal shapes — a declared-only identity is `target-unresolved`
(it never establishes a target artifact set) and a *resolved* identity whose BOM differs is
`context-mismatch` naming both BOMs; and `hashTree()` of each temp project is identical before and
after every read path, so no read writes to a project.

### 2. Operation matrix (brief bullet 2, resolution 2) — `test/toolchain-consumers.mjs`

Every row runs on one fixture host carrying a **complete 0.13 install and a complete 6.1 install**
under `/sdk`, so a legacy fallback would silently succeed instead of failing loudly.

| Test | Covers |
| --- | --- |
| `S6 matrix: every packer/editor consumer runs the SELECTED 6.1 binary on a host that also carries 0.13` | `resolveOperationToolchain`, `packerToolchain` (inspect_bundle/bake), `resolveSchemaToolchain` (scene_schemas), `resolveSceneToolchain` (packer-only and packer+editor), and `prepareOperationToolchain` under the `editor_export_bundle`/`bundle_diff` request (those two hold no injectable seam of their own — the shared helper under their exact request is the honest row, and the existing source gate pins that they build it). Plus the real pack argv through a recording runner, and the editor component resolving the 6.1 app bundle. |
| `S6 matrix: the preflight pico-sdk and adb rows read the selection, and their captured exec log launches nothing legacy` | `runPreflightChecks` with a captured `io.exec`: the adb row lands on the selected 6.1 bundled platform-tools and the legacy 0.13 candidate is never reached; the `pico-sdk` row says `packer 6.1 from PICO_HOME /sdk` with no `0.13` in it; **with an explicit `$PICO_ADB` set the only adb probe is that override** — no bare `adb`, no bundled, no legacy. |
| `S6 matrix: adb and the emulator proto schema follow the selected installation; adb resolution spawns nothing` | `resolveAdbExecutable` picks the 6.1 bundled adb, every probed candidate is an absolute path (never a bare name or a shell lookup), an unusable explicit override fails closed with `probed === [override]` and `adbExecutable` throws; `loadProto()` over a real temp tree carrying 0.13 and 6.1 serves 6.1 by default and does not serve a cached 0.13 schema to a 6.1 request. |
| `S6 matrix: vault and lint answers follow the selected tools root and stay historical without reviewed evidence` | `vault_api` and `preflight_lint` through their registered handlers, under a temp `PICO_HOME` carrying a `0.13`- and a `6.1`-labelled vault that **both** declare `0.13.3`: the reported `packageRevision` is `0.13.3` for the `6.1` label, `lookup` is `historical`, `verifiedMatches`/`incompatibleMatches` are empty, `compatibilityIndex` is `present` with 0 records, the lint vault root is derived from the selected tools root, and `clean === (violations.length === 0 && counts.projectErrors === 0)`. |
| `S6 matrix: failed and missing selections are reported as themselves, never degraded to another binary` | Independently asserted: no installation (`root-unavailable`), an install with no packer (`component-missing`), an uninstalled pin, and the editor component off macOS. Each carries no `bin`, flattens to the same `code: detail` shape through the shared helper, and never names the legacy payload. Plus the one case that legitimately carries an operation past a missing selection — an explicit `$PICO_SPATIALBUNDLE` — disclosed rather than substituted. |
| `S6 matrix: the same mixed host on win32 and linux FIXTURES selects the 6.1 payload published for that platform` | win32 `.exe` payloads under a drive root and linux bare names under an explicit root; both select 6.1, both refuse the macOS-only editor component. **Fixture-only**, labelled so in the test. |
| `S6 matrix: the ONE legacy \`which adb\` probe left in the server is bounded to validate_toolchain and does not spread` | Honest scoping — see Concern 1. |

Zero legacy fallback launches is asserted three ways: no captured runner/exec call matches
`/0\.13\/|which|command -v|where/`; no selected `bin` is the 0.13 packer; and with an explicit
override set the bare-`adb` last resort is provably not reached.

### 3. CLI boundary (brief bullet 3, resolution 3) — `test/declarationcontext.mjs` §7

`a fabricated CLI version/fingerprint hint never becomes authority: only the local bytes decide,
and an unsupported transport stays unavailable`. The fixture simulates the knowledge adapter
handing the SDK `{cliVersion: "0.5.0", workspaceRoot, fingerprint, packageRevision: "6.1.0"}` —
matching the plan's own interface ruling (`progress.md:48`: *"S5 owns readDeclarationIdentity /
loadVerifiedCompatibilityEvidence; C2 supplies hints only"*). Five assertions:

1. the hint **selects a root**; the revision read back is `0.13.3` (from `package.xml`) and the
   fingerprint is the reader's, not the hinted one;
2. an identity carrying the hinted revision and fingerprint, with every other field copied from a
   genuine read, is rejected `context-mismatch` and throws `TypeError` in the resolver;
3. a reviewed record that *claims* the hinted revision is measured against the bytes on disk and
   rejected `context-mismatch`;
4. the genuine tuple still verifies (1 accepted, `packageRevision` `0.13.3`) — so 2 and 3 are
   refusals, not a dead fixture;
5. an unsupported transport (a workspace root this process cannot read as a declaration root)
   stays `unavailable` (`root-unavailable` / `declarations-missing`), never degrades to
   `historical`, and never echoes the hinted revision in its detail.

### 4. `scripts/verify-sdk-compatibility-payload.mjs` (brief bullet 5)

`verifySdkCompatibilityPayload(packageRoot) -> {ok: boolean, checked: FileIdentity[], errors: string[]}`,
synchronous, pure `node:fs` + `node:crypto`. It resolves **only** from `packageRoot` — a
non-string, empty or relative root is refused outright (a relative root's error says `absolute`),
and the script contains no reference to the working directory, no environment read, and no use of
its own module location. `checked[].path` is a package-relative posix path
(`data/sdk-compatibility/…`) so two relocations of the same bytes compare equal.

One pass: (1) the index exists and is a v1 reviewed index (strict field set, bounded relative
paths, 64-hex digests, no duplicates, no record/historical overlap); (2) every referenced file —
records and historical basis alike — is present, resolves inside the data directory and hashes to
exactly its indexed sha256; (3) every reviewed record parses and cites only basis snapshots the
index declares at the same hash, so the transitively required basis really shipped. An **empty
`records` list is valid**; a missing index, or a declared basis that is absent or altered, is not.

### 5. `test/declarationcontext-installed.mjs` (brief bullet 6, resolution 3)

Eight tests over relocated package fixtures built in temp dirs containing **only** `dist/`,
`data/sdk-compatibility/` and `package.json` — asserted directly
(`readdirSync(installed).sort() === ["data","dist","package.json"]`, and `docs/`, `test/`,
`node_modules/`, `appskeleton/` explicitly absent).

- `the canary verifies the packaged index and every referenced byte, resolving from packageRoot and never from the working directory` — source tree and relocated package produce **deep-equal `checked`**; a child `node` process with `cwd` set to an unrelated empty temp dir returns byte-equal JSON; a root with no packaged data fails and names the root.
- `an empty reviewed mapping list is valid; a missing index is not`.
- `the relocated package loads its historical references through its own module URL, with no docs/ or test/ present` — the relocated `dist/declarationcontext.js` resolves `SDK_COMPATIBILITY_DATA_DIR` to the fixture (never the source checkout), and `readCompatibilityIndex()` loads and re-hashes every historical reference.
- `removing a required basis file makes the payload unavailable, and restoring its exact bytes recovers fresh loading in the same process` — removed → `ok:false` + `evidence-hash`; restored-but-altered → still refused, naming the indexed hash; exact bytes restored → the **same module instance** returns `ok` again.
- `a previously accepted mapping does not survive a changed or missing packaged basis, and comes back only when the exact bytes do` — through the S5 injection seam (a `DeclarationIO` over the real filesystem plus an explicit `(coordinate, sha256) -> path` artifact table): a synthetic reviewed record over an on-disk vault, project and artifacts is **accepted** (`target-compatible`); changing the packaged basis then refuses it (`evidence-hash`, context back to `unknown`, canary red); removing it refuses it the same way; restoring the exact bytes accepts it again in the same process.
- `a record whose basis the installed index does not declare at the same hash is refused, even when every indexed byte matches` (undeclared / wrong hash / no basis / the good case).
- `a malformed or wrong-version installed index is refused rather than partially trusted` (non-JSON, schemaVersion 2, unexpected field, escaping reference, short hash — each with `checked === []`).
- `the canary reads only: it starts no process, opens no network, and never consults the working directory` (source gate + the input refusals).

No CLI, provider, Java, Gradle, emulator, device or native process is started anywhere. The only
child process is `node` running the canary for the cwd-independence proof.

---

## TDD evidence — RED, then GREEN

**RED 1** (the intended one): `test/declarationcontext-installed.mjs` was written and run before
the canary existed.

```
$ node --test test/declarationcontext-installed.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '…/scripts/verify-sdk-compatibility-payload.mjs' imported from
  '…/test/declarationcontext-installed.mjs'
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

**RED 2** (an expectation of mine that was wrong, not the code): the combined fixture first
asserted `context-mismatch` for a declared-only project against a 9.9.9-target record, and got
`["target-unresolved"]`. The loader is right — a declared-only identity never establishes a target
artifact set, so it is refused before the BOM is compared. The test now asserts **both** refusal
shapes. Two further reds were `/var/…` vs `/private/var/…`: both values are canonical by design,
so the assertions now compare canonically. All four are recorded in the evidence note.

**Mutation testing** (the suites were green on their first post-implementation run, so every claim
was checked by breaking the thing it claims; each file restored byte-identically and rebuilt):

| Mutation | Caught by |
| --- | --- |
| canary: hash comparison removed | basis-lifecycle + accepted-mapping tests |
| canary: data dir from the script's own location instead of `packageRoot` | 6 failures incl. the cwd-independence test |
| canary: a missing referenced file skipped silently | basis-lifecycle test |
| canary: a relative `packageRoot` accepted | canary-discipline test |
| canary: record-basis cross-check removed | undeclared-basis test |
| canary: `ok` hardcoded true | 3 failures |
| `src/preflight.ts`: an explicit `$PICO_ADB` no longer stops the candidate walk | the preflight matrix row |
| `src/adb.ts`: a rejected explicit override falls through to PATH/bundled | the adb/proto matrix row |
| `src/projectidentity.ts`: a dynamic catalog version taken as literal | the combined fixture |
| `src/toolchainselection.ts`: the OLDEST usable installation selected | 4 S6 tests |

All 10 caught, none missed. `git status` after the sweep showed no `src/` change.

---

## Tests and results (final, at `30cfb12`)

```
$ npm run build                                                        # tsc, exit 0
$ node --test test/toolchain-resolution.mjs test/toolchain-consumers.mjs \
      test/projectidentity.mjs test/toolchain-cache.mjs \
      test/declarationcontext.mjs test/declarationcontext-installed.mjs
  ℹ tests 173   ℹ pass 173   ℹ fail 0
```

Per-suite: `toolchain-resolution` 48/48, `toolchain-consumers` 36/36 (+7 S6),
`projectidentity` 24/24, `toolchain-cache` 32/32, `declarationcontext` 25/25 (+2 S6),
`declarationcontext-installed` 8/8 (new).

| Existing host suite | Result |
| --- | --- |
| `node test/preflight.mjs` | Failures: 0 |
| `node test/projectgen.mjs` | Failures: 0 |
| `node test/vault.mjs` | Failures: 0 |
| `node test/vaultdiff.mjs` | Failures: 0 |
| `node test/lint.mjs` | **Failures: 3** — the known R3-owned battery baseline, byte-for-byte the same as at base: `test:runrevision` not in `gates.yml`; README/COLLABORATORS claim 47/46 vs 49/48. Untouched by S6. |
| `node test/doors.mjs` | Failures: 0 |

Also run to prove S6 changes neither gate: `node test/docsmeta.mjs` → Failures: 0 (162 links,
72 files); `node --test test/distribution-adoption.mjs` → 41/43, the same two inventory counts as
before this task.

**Not run, deliberately** (brief bullet 7): `npm run test:tarball`. It is known-red in this
worktree by design — the built payload derives `data` as a required sibling directory while
`package.json` `files[]` does not yet ship it. That red *is* the canary. Also not run:
`test/provision.mjs`, broad smoke, emulator calibration, any native acceptance. No MCP tool was
called.

---

## Handoff — the two edits the release/integration task must make

Both are outside S6's ownership and were deliberately not made.

### A. `package.json` — add exactly one entry to `files[]`

Current allowlist (unchanged by S6):

```json
"files": ["dist", "scripts", "tools", "briefs", "appskeleton", "unityskeleton", "assets",
          "GETTING_STARTED.md", "TESTERS.md", "SKILLS.md", "DESIGN.md"]
```

Add `"data/sdk-compatibility"` — **not** `"data"`, and never `"docs"` or `"test"`. Placing it
immediately after `"dist"` reads best:

```json
"files": ["dist", "data/sdk-compatibility", "scripts", "tools", "briefs", "appskeleton",
          "unityskeleton", "assets", "GETTING_STARTED.md", "TESTERS.md", "SKILLS.md", "DESIGN.md"]
```

That ships `data/sdk-compatibility/index.v1.json` plus `basis/sdk-6.0.0-drift.md` and
`basis/sdk-adoption-provenance.json` (68 KB total, 3 files), which is the index, its transitively
required basis snapshots and nothing else. It also makes
`scripts/verify-tarball.mjs`'s existing `[M1]` check pass: `derivedSiblingDirs()` already derives
`data` from the built `dist/` (measured: `appskeleton, assets, briefs, data, package.json,
scripts, tools, unityskeleton`).

### B. `scripts/verify-tarball.mjs` — invoke the canary on the extracted package

Insert immediately after the `[M1]` sibling-directory loop, which currently ends at line 237
(`  }` closing the `for (const d of needed)` loop) and before the `// [M2] Content, not just a
directory.` comment. `pathToFileURL`, `path`, `installed`, `ok` and `fail` are all already in
scope, and the enclosing block already uses top-level `await import`:

```js
  // [M6] The reviewed SDK-compatibility payload must ship intact: dist/declarationcontext.js
  //      resolves data/sdk-compatibility/ from its own module URL, so a tarball missing it
  //      installs a server whose declaration authority silently degrades to index-missing.
  //      The INSTALLED copy of the canary is used, so this proves the script shipped too.
  try {
    const { verifySdkCompatibilityPayload } = await import(
      pathToFileURL(path.join(installed, "scripts", "verify-sdk-compatibility-payload.mjs")).href
    );
    const payload = verifySdkCompatibilityPayload(installed);
    payload.ok
      ? ok(`reviewed SDK-compatibility payload verified (${payload.checked.length} files, index + every referenced record/basis)`)
      : fail(`reviewed SDK-compatibility payload missing or altered: ${payload.errors.slice(0, 3).join("; ")}`);
  } catch (error) {
    fail(`SDK-compatibility payload canary could not run against the installed package: ${error instanceof Error ? error.message : String(error)}`);
  }
```

Note the marker comment style (`[Mn]`) is load-bearing prose in this file's header block; if `[M6]`
is taken by then, use the next free number and add the one-line summary to the header list.
`scripts/sync-metadata.mjs` parses this file for `const EXPECTED_TOOLS = <digits>` and for the run
of doors entries before the `// core lanes` comment — the insertion above touches neither.

### C. CI registration — every SDK-track suite still runs in no workflow

S1–S6 added six suites and none is in `package.json` `scripts` or `.github/workflows/gates.yml`.
S6 deliberately added no `test:` script (an unregistered one trips
`test/distribution-adoption.mjs`, which is already red for its own count reasons). The full list
the release owner must register, as one gate:

```json
"test:sdkselection": "node --test test/toolchain-resolution.mjs test/toolchain-consumers.mjs test/projectidentity.mjs test/toolchain-cache.mjs test/declarationcontext.mjs test/declarationcontext-installed.mjs"
```

| Suite | Owner task | Notes |
| --- | --- | --- |
| `test/toolchain-resolution.mjs` | S1 | pure fixtures |
| `test/toolchain-consumers.mjs` | S2, extended by S6 | fixtures + temp proto tree + temp vault/project; mutates `PICO_HOME`/`PICO_AGENT_VAULT` inside `try/finally` |
| `test/projectidentity.mjs` | S3 | temp projects |
| `test/toolchain-cache.mjs` | S4 | fixtures + temp proto tree |
| `test/declarationcontext.mjs` | S5, extended by S6 | fixtures + temp projects; reads the repo's own packaged data |
| `test/declarationcontext-installed.mjs` | S6 (new) | temp relocated packages; **requires `npm run build` first** (it copies `dist/`) and spawns one `node` child |

Registering the gate also changes the battery counts `test/lint.mjs` and
`test/distribution-adoption.mjs` assert (`gates.yml` ↔ `package.json` ↔ README ↔
`docs/COLLABORATORS.md`), which is R3's chain.

---

## Self-review

- **Completeness** — all 12 brief checkboxes and all five controller resolutions have at least one
  test. Resolution 4's capability rows are all present in the evidence note, each linking an
  **exact test name**: structural 6.1 selection, explicit-component refusal, project-BOM
  preservation, cache replacement, historical lookup, target-matched authority (marked unreachable
  end-to-end), darwin/win32/linux fixtures (each marked fixture-only), payload discovery vs binary
  compatibility, provider help vs semantic behaviour, plus a row scoping the "no legacy launch"
  claim. Real host binary probes, artifact resolution against a real Gradle cache, SDK 6.1 native
  acceptance, the installed-tarball lifecycle and cross-platform support are UNEXECUTED rows and
  say so.
- **Discipline** — no `src/**`, `package.json`, `verify-tarball.mjs`, `.gitignore`, `.github/**`,
  `test/distribution-adoption.mjs` or `test/helpers/**` change. `test/helpers/toolchain-fixture.mjs`
  needed no addition: `declarationIOFromTree`/`toolchainIOFromTree`/`macSdkTree` covered every new
  fixture, and the installed suite's filesystem-backed `DeclarationIO` is local to that file. No
  managed-CLI policy text was written or paraphrased anywhere.
- **Testing** — real `mkdtemp` fixtures throughout; output is pristine (0 failures outside the
  pre-existing lint battery baseline); no CLI, provider, Java, Gradle, emulator, device or native
  process started; the repository's own `data/` was only read.
- **Verified: the canary resolves from `packageRoot` only** — mutation M2 (data dir from the
  script's own location) fails 6 tests; the child-process run from an unrelated cwd returns
  byte-equal JSON; a relative root is refused.
- **Verified: the installed fixture carries no `docs/` or `test/`** — asserted by an exact
  `readdirSync` equality plus four explicit absences.
- **Verified: the evidence note labels classes honestly** — everything is `structural`, split into
  in-memory fixture / temp-filesystem fixture / source-text gate, with a standing statement that
  nothing here is runtime, visual or native acceptance.

---

## Concerns

1. **A pre-existing legacy `which adb` probe remains, and S6 may not fix it.**
   `src/toolchain.ts:483` (`findAdb`, reached only by `validateToolchain`, i.e. the
   `validate_toolchain` tool) still spawns `which adb` and then a version-joined platform-tools
   path, ignoring `$PICO_ADB` entirely. This is the deferred S4 minor already ledgered in the
   plan's `progress.md:157`, not something my tests newly exposed, and `validate_toolchain` is not
   one of the operations resolution 2 enumerates. Rather than fix `src/` (forbidden here) or add
   noise with a knowingly-red test, I **pinned** it: `S6 matrix: the ONE legacy \`which adb\`
   probe left in the server is bounded to validate_toolchain and does not spread` asserts the
   probe exists at exactly one location, has exactly one caller, and is imported by no other
   module. If S4's follow-up removes it, that test must be updated in the same change. **The
   matrix's "no legacy launch" claim is scoped to the operations it exercises, not to the whole
   server.** This is why the status is DONE_WITH_CONCERNS.

2. **`target-compatible` is still unreachable through any tool surface** (S5 concern 1, unchanged).
   `vault_api` and `preflight_lint` read the project with `readProjectSdkIdentity(projectRoot)` and
   never accept caller-supplied `resolvedArtifacts`, so every door-level context is
   `historical`/`unknown`. S6 proves the positive path with SDK-owned objects
   (`test/declarationcontext-installed.mjs`, the accepted-mapping test), and the evidence note
   records row 6b as UNREACHABLE-BY-DESIGN rather than pretending a tool can reach it.

3. **Platform coverage is fixture-only.** win32 and linux rows are in-memory trees on a darwin
   host. They prove the selection logic is platform-correct; they are not evidence that this server
   has ever run on Windows or Linux, and the tests and the evidence note both say so.

4. **Structural payload discovery is not binary compatibility.** The canary proves the reviewed
   index and its basis shipped and are byte-identical after relocation. It says nothing about a
   6.1 payload being executable, nor about the 0.13.3 declarations describing a 6.1 SDK.

5. **The relocated fixture copies the whole `dist/` (~4.7 MB) four times** across the suite —
   about 200 ms total, but it is real I/O. A future trim could copy only
   `declarationcontext.js` + `projectidentity.js` (the module's full import closure); I chose the
   whole directory so the fixture is a faithful package layout.

6. **`test/toolchain-consumers.mjs` now mutates `PICO_HOME`/`PICO_AGENT_VAULT`** in two tests
   (restored in `finally`). Node's runner executes tests in a file sequentially, so there is no
   cross-talk today; a future `--test-concurrency` change inside a file would need those blocks
   isolated.

7. **The installed suite spawns one `node` child process.** That is the strongest available proof
   of cwd independence. It is `node` only — no CLI, provider or native binary — and the argument is
   a `file://` URL built with `pathToFileURL`, so a path with spaces or non-ASCII characters is
   safe.

8. **`npm run test:tarball` is red in this worktree and will stay red until edit A lands.** That is
   the intended canary, not a regression; the brief forbids running it from this task.

9. **`pico_doctor {}` was not run** — the dispatch forbids MCP tool calls. The work is host-only
   tests, one script, fixtures and git.
