# Task S5 — Make declaration authority explicit and versioned

Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-sdk-2026-09-15` (branch `track/cli050-sdk`)
Base: `69f7b48` (S1–S4 complete and reviewed). Not pushed. Trailer verified on all three commits.

| Commit | Subject | Files |
| --- | --- | --- |
| `5a8ddd9` | `data: package the historical SDK compatibility basis with an empty reviewed index` | `data/sdk-compatibility/index.v1.json`, `data/sdk-compatibility/basis/sdk-6.0.0-drift.md`, `data/sdk-compatibility/basis/sdk-adoption-provenance.json` |
| `4ff270f` | `fix: bind SDK declaration authority to explicit provenance` | `src/declarationcontext.ts` (new, 862 lines), `test/declarationcontext.mjs` (new, 744 lines), `test/helpers/toolchain-fixture.mjs` (+42, additive) |
| `dde0669` | `fix: label vault lookups by declared revision and verified target linkage` | `src/vault.ts` (+259/−45 → 1159 lines, was 940 at base), `src/vaultdiff.ts` (183 → 241), `src/lint.ts` (1052 → 1071, vault stage only), `src/doors.ts` (pico_sdk hunk only), `test/vault.mjs`, `test/vaultdiff.mjs`, `test/lint.mjs`, `test/doors.mjs` |

Status: DONE. Every brief checkbox and all seven controller resolutions are implemented and
tested; `records` in the packaged index is empty; no historical evidence was relabeled; no
CLI, Gradle, Java, service, emulator, device or real-vault read was added.

---

## What I implemented

### `src/declarationcontext.ts` — the SDK-owned reader, loader and resolver

Imports `FileIdentity`/`ToolchainIO` from `toolchainselection.ts` and
`readProjectSdkIdentity`/`ProjectSdkIdentity` from `projectidentity.ts`; the seven exported
types and three function signatures are the brief's text verbatim (including
`declare const verified: unique symbol` as the module-private type brand). Nothing in the
module spawns a process, runs Gradle or the CLI, contacts a service or writes; a source-text
gate in the suite pins that.

**`readDeclarationIdentity(root, io?)`** (resolution 2). Canonical root via `io.realpath`;
declaration files are the flat `knowledge/api-reference/*.md` set — the same set
`loadVaultIndex` and S4's cache key use — and `package.xml` is parsed with the shared
`parsePackageRevision` (exported; `loadVaultIndex` now uses it too). `authority:"declarations"`
requires a parsable revision AND at least one declaration file; a root with only
`knowledge/documentation/*.md` is `prose` (revision reported if present, `null` otherwise).
`unavailable` codes: `root-unavailable`, `declarations-missing` (a directory-only hint),
`package-xml-missing`, `package-xml-revision-malformed` (both name the file in code and
detail), `declaration-unreadable`, `declaration-escape` (realpath outside the canonical
root), `declaration-duplicate` (two entries with one canonical path), `declaration-changed`
(a second read pass re-hashes every file; a mismatch refuses the identity). `sources` are
sorted root-relative posix `FileIdentity`s (`package.xml` + the declaration files);
`fingerprint` = sha256 over `pico-declaration-identity/1\n<authority>\n` followed by the
sorted `${relpath}\0${sha256}\n` lines — the entry format resolution 2 specifies, with a
versioned prefix and the authority line added so a prose root and a declaration root can
never collide (the suite pins the exact material). Identities are frozen and retained in a
module-private `WeakSet`; nothing reads a revision from a path.

**`loadVerifiedCompatibilityEvidence(paths, source, target, io?)`** (resolutions 1, 3). The
only candidates are records whose canonical path equals `<data dir>/<index.records[i].path>`
and whose bytes hash to the indexed sha256; `paths` may be absolute or data-dir-relative and
can only SELECT. Per path, in order: `record-not-reviewed` (index unavailable, path not
indexed, unreadable, basis not a reviewed historical reference) → `evidence-hash` (record
bytes ≠ index entry; any index-referenced file altered/missing — the whole index is one
unit; basis hash mismatch; artifact bytes ≠ reviewed hash; signature derivation mismatch)
→ `record-schema` (JSON parse, `schemaVersion !== 1`, any unexpected field such as
`projectRoot`/`projectFingerprint`/`binding`/`compatible`, missing fields, non-literal
`packageRevision`/`targetBom`, coordinates outside
`group:artifact:version[:classifier]@extension` with an exact version, wildcards or globs in
`symbols`/`signatures`, a signature outside the symbol scope, no source or no target
artifact, empty/absolute/escaping `basis`, `sourceFiles` outside `package.xml`/`knowledge/`)
→ `context-mismatch` (source not reader-produced; prose; the vault root re-read no longer
matches the source fingerprint; record fingerprint/revision ≠ source; a `sourceFiles`
entry absent from the source set; a scoped symbol not declared in the listed source files;
project declares no literal BOM or a different one; the normalized SDK artifact set differs)
→ `target-unresolved` (target `declared`/`unknown` or no resolved artifacts; the project
changed since its identity was read) → `artifact-unavailable` (`io.artifactPath` null or
unreadable, either side). After a record verifies, the project is re-read ONCE per call
with `readProjectSdkIdentity(target.projectRoot, {resolvedArtifacts})` and the acceptance is
bound to `{projectRoot, projectFingerprint, artifactsFingerprint}` of that fresh read.
Accepted evidence is deep-frozen, carries `record:{path (canonical), sha256}`, and is added
to the module-private `WeakSet`.

SDK-set normalization: every resolved artifact in a `com.pico.spatial*` group plus any
`group:artifact` the record's target artifacts explicitly identify (that is how a Compose fork
under another group would enter; the drift document's Compose-fork coordinates are all
`com.pico.spatial.ui*`, so the prefix already covers them). Unrelated application
dependencies never enter; an SDK-group coordinate that does not parse is reported and
prevents an exact match; the record's target set must equal the project's normalized set
exactly (sorted `coordinate\0sha256`).

Signature derivation (documented in the module header): `sourceSha256 =
sha256("pico-signature-source/1\n"+symbol+"\n"+declarationFingerprint+"\n"+sorted
"coordinate\0sha256\n" of the SOURCE artifacts)` and `targetSha256 =
sha256("pico-signature-target/1\n"+symbol+"\n"+targetBom+"\n"+… TARGET artifacts)`. The
loader recomputes both from the inputs it verified and requires each scoped symbol's simple
name to be declared (`# Name` header or a Kotlin declaration keyword) in the record's listed
source files. This is a binding commitment over verified bytes; it is NOT a parse of Kotlin
signatures out of a binary, which static host code cannot do honestly. Both helpers are
exported (`deriveSourceSignatureSha256`, `deriveTargetSignatureSha256`) and the suite pins
the raw formula independently.

**`resolveDeclarationContext(source, target, evidence)`** (resolutions 4, 5). Throws
`TypeError` for a source not produced by the reader; ignores every evidence entry that is not
in the loader's `WeakSet` or whose binding/fingerprint/revision/BOM/artifact-set does not
match the fresh `target`. No target → `historical` (empty paths/symbols); no applicable
evidence → `unknown`; any applicable `incompatible` record, or a symbol claimed by both
verdicts → `incompatible`; else `target-compatible`. `verifiedSymbols` is exactly the
compatible scope minus conflicts; prose never resolves.

Also exported: `SDK_COMPATIBILITY_DATA_DIR` / `SDK_COMPATIBILITY_INDEX_PATH` (from
`new URL("../data/sdk-compatibility/", import.meta.url)` — `<package>/data/sdk-compatibility`
once installed, never cwd), `readCompatibilityIndex(io?)` (strict index schema; re-hashes
every referenced file; `index-missing`/`index-schema`/`evidence-hash`), `indexedRecordPaths(io?)`,
`hostDeclarationIO(env?, home?)` (fs-backed; `artifactPath` is a read-only lookup in
`$GRADLE_USER_HOME|~/.gradle/caches/modules-2/files-2.1/<group>/<artifact>/<version>/*/<file>`
returning a path only when the bytes hash to the requested sha256), `parseArtifactCoordinate`,
`parsePackageRevision`, `SDK_ARTIFACT_GROUP_PREFIX`.

### `data/sdk-compatibility/` — the package-owned reviewed index (resolution 1)

`index.v1.json` = `{schemaVersion:1, records:[], historicalReferences:[…]}`; paths are relative
to `data/sdk-compatibility/`. `records` is EMPTY: no complete reviewed mapping exists. The two
historical references are byte-for-byte copies (`cp -p`, `cmp`-verified, asserted by the suite
against the originals, which are unchanged vs base):

| File | sha256 |
| --- | --- |
| `data/sdk-compatibility/index.v1.json` | `1f872b67ac292df72f5c6659fc89b36e7d182089013e5350421b6913da2ad0d6` |
| `data/sdk-compatibility/basis/sdk-6.0.0-drift.md` (= `docs/SDK_6_0_0_DRIFT.md`) | `e1671fbdaf1ee278298258f4aa3c5771861a677e37e22e8281d0ffc7eb7d6b5a` |
| `data/sdk-compatibility/basis/sdk-adoption-provenance.json` (= `test/fixtures/sdk-adoption-provenance.json`) | `058bbf48ae902a22dd77f23e6a4427fc2bb5349ee09cede268aefbf76fa3f20e` |

The historical core hashes (`29b5ec6b…dcd0` for 0.13.3, `92bc5d19…db5df` for 6.0.0) are
retained inside the basis document as inputs only; the suite asserts they are present there
and that no record exists.

### `src/vault.ts` — root resolution unified; lookups labeled

- `vaultSdkBase()` uses `resolveRootCandidate({}, hostToolchainIO())` — the S1 candidate chain
  (`$PICO_HOME` else the documented default); on a platform with no documented default it
  keeps the previous `~/Library/PICO/sdk` spelling (no new platform default). `defaultVaultRoot()`,
  `vaultRootForVersion()` and vaultdiff's enumeration all derive from it; `PICO_AGENT_VAULT`
  still overrides the default.
- `resolveVaultSelection({vaultRoot, sdkVersion})`: explicit root (must be absolute after
  `~` expansion, else `root-invalid`) > numeric `sdkVersion` (`isVersionToken`, else
  `version-invalid` — never joined into a path) > env > default. Source labeled
  `explicit|version|env|default`.
- `describeDeclarationAuthority(vaultRoot, {projectRoot?, recordPaths?}, io?)` reads the
  declaration identity, the project identity (`readProjectSdkIdentity`, statically) and loads
  `recordPaths` or every indexed record; `symbolAuthorityOf(authority, symbols)` yields
  `unavailable|historical|unknown|incompatible|target-compatible` for one lookup.
- `vault_api` inputs: `symbol`, `sdkVersion`, `vaultRoot`, `projectRoot`, `recordPaths` — hints
  only; no identity, fingerprint or verdict field exists in the schema. Every result now also
  carries `lookup` (`historical` unless a reviewed record verifies → `target-verified`),
  `symbolAuthority`, `vaultSelection`, `declarationIdentity`, `target`, `declarationContext`
  (`status`, `evidencePaths`, `verifiedSymbols`, `rejected`, `note`) and an extended
  `vaultProvenance` (`packageRevision`, `declarationAuthority`, `vaultRoot`, `rootSource`; the
  three fields `test/vault.mjs:15–21` pins are unchanged). A `not-found`/`documented-only`
  answer beside a target states that the absence is a fact about the historical revision and
  says nothing about the project's SDK. `documented-only` is preserved and labeled secondary.

### `src/vaultdiff.ts`

`VaultWorkspace` gains `packageRevision` (from `package.xml`; `version` stays the directory
label — separate facts). `resolveVaultDiffRoot(spec)`: a spec with a separator is an explicit
root and must be absolute; anything else must be a numeric label; both refusals are
structured errors before any filesystem access. `vault_diff` results carry `authority:
"historical"`, an `authorityNote`, and each side's declaration identity summary and root
source; `vault_workspaces` reports its `base` and the label-vs-revision note. The module no
longer spells its own home-relative base (`os` import removed).

### `src/lint.ts` (vault stage only)

With `projectDir` the advisory `vault` block adds `declarationIdentity`, `target`,
`declarationContext` and an `authorityNote`; the `note` calls the findings HISTORICAL lookups
and states the linkage unless it is `target-compatible`. `clean` is computed exactly as before
(`violations.length === 0 && projectErrors === 0`) and the suite asserts that equality with
and without a project hint.

### `src/doors.ts` (pico_sdk hunk only)

`pico_sdk` forwards `projectRoot`/`vaultRoot`/`sdkVersion`/`recordPaths`; its description
labels the default lookup historical, keeps the `0.13.3` and `docs/SDK_6_0_0_DRIFT.md`
disclosures, and says hints never assert a verdict. Nothing else in `doors.ts` was touched
(the CLI track's perf-axis region ~985–1015 is untouched).

---

## TDD evidence

### RED 1 — the suite exists, the module does not (retained)

```
$ npm run build            # tsc, clean (no new source yet)
$ node --test test/declarationcontext.mjs
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///…/cli050-track-sdk-2026-09-15/dist/declarationcontext.js'
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

The whole suite — declaration fixtures, both verbatim brief snippets, the indexed fixture
record and the two-project reuse scenario — was written before any implementation; the
brief's ordering (fixtures + snippets, then implement, then record/reuse, then integration)
was followed as "all unit cases in one RED, one implementation, then integration".

### GREEN, then mutation testing (because the suite was green on its first implementation run)

`node --test test/declarationcontext.mjs` → `tests 21, pass 21, fail 0` on the first build.
Following the S3 lesson, 16 mutations of `src/declarationcontext.ts` were each built, run and
restored (byte-identical restore verified with `cmp`):

| Mutation | Caught by |
| --- | --- |
| resolver accepts any object (WeakSet check removed) | branding test (1 fail) |
| loader skips the fresh vault re-read | "every bound file mutated" (changed revision / declaration bytes) |
| reader skips its verify pass | changed-during-read test |
| signature derivation not checked | signature-derivation test |
| index membership ignored (any hashed path accepted) | 3 fails: brief snippet #1, mutation table, unindexed copy |
| canonical root hashed into the fingerprint | 2 fails: material pin, cross-root identity |
| artifact bytes not verified | mutation table |
| binding ignored in `appliesTo` | brief snippet #2 |
| prose allowed as authority | prose test |
| revision inferred from the directory label | package.xml test |
| wildcard symbols accepted | record-schema test |
| declared-only target accepted | target-unresolved test |
| historical references not re-hashed | mutation table |
| fresh project re-read skipped | stale-identity test |
| stale-binding sub-clauses (`status`/`declaredBom`) removed while root+fingerprint kept | **not observable** — those two clauses are redundant with the fingerprint comparison (same allowlisted files ⇒ same BOM/status); kept as defensive checks, noted here honestly |

Note: `tsc` emits JS on type errors (`noEmitOnError` is off), so two mutations that broke
narrowing still ran against the mutated `dist/` and were caught; recorded so nobody reads a
red `tsc` as a skipped mutation.

### Integration layer — first run of the new consumer cases found a real defect

The vault/vaultdiff/lint/doors cases were written after the integration code. Their first run
was red in two vaultdiff cases: a relative explicit root such as `../etc` was being resolved
against the server's working directory (pre-existing `resolveRoot` behaviour I had carried
over). Fixed by requiring explicit roots to be absolute in both `vault_diff`
(`resolveVaultDiffRoot`) and `vault_api` (`root-invalid`); the cases now pass and a
`vaultRoot: "../x"` case was added to `test/vault.mjs`.

---

## Tests and results (final build `dde0669`)

| Command | Result |
| --- | --- |
| `npm run build` | clean |
| `node --test test/declarationcontext.mjs` | 21/21 |
| `node test/vault.mjs` | Failures: 0 (lines 15–62 historical assertions untouched; S5 block adds 45 assertions; real-vault cases ran on this machine as before) |
| `node test/vaultdiff.mjs` | Failures: 0 (S5 block adds 12) |
| `node test/lint.mjs` | S5 block 10/10; **3 pre-existing failures** — the battery inventory defect recorded at baseline (progress.md 09:53Z: `test:runrevision` not in gates.yml; README/COLLABORATORS 47/46 vs 49/48), owned by R3, untouched by these files |
| `node test/doors.mjs` | Failures: 0 (S5 contract case added; `pico_sdk` labeled `unavailable` in the harness's isolated HOME) |
| `node --test test/toolchain-resolution.mjs test/toolchain-consumers.mjs test/projectidentity.mjs test/toolchain-cache.mjs` | 133/133 |
| `npm run test:prompts` | 3/3 |
| `node test/docsmeta.mjs` | Failures: 0 (162 links, 72 files) |
| `node --test test/distribution-adoption.mjs` | 41/43 — the two failures are the baseline count defects (`{linux:44,…}` vs 45; 46 vs 48 scripts); the tracked-markdown evidence guard passed with the new basis copy |

What `test/declarationcontext.mjs` covers: packaged index/basis byte identity and hashes;
brief snippet #1 verbatim; identity material pin, cross-root equality, insertion-order
independence, label-not-revision; package.xml missing/malformed; absent root, directory-only
hint, empty api-reference, unreadable file; symlink escape, duplicate canonical, changed
mid-read; prose root (+ a record crafted around the prose fingerprint); acceptance with both
artifact reads proven, binding, frozen result, relative record path; the derivation formula
pinned and a wrong hash refused; each bound file mutated on its own (index entry, record
removed from index, index missing/malformed/unknown schema, record bytes, basis bytes/missing,
altered packaged drift copy, package revision, declaration bytes, missing target/source
artifact, altered artifact bytes, artifact path without file); 21 record-schema refusals
(including `projectRoot`, `projectFingerprint`, `compatible`, `binding`, ranges, wildcards,
version-less coordinates); unlisted basis and a byte-identical copy at an unindexed path;
context mismatch (wrong BOM, unexpected SDK module, app dependencies ignored, drifted source);
declared-only/unknown/no-BOM targets and a stale identity refused until re-read;
0.13.3 → 6.1.0 with valid versions staying unknown (fixture index, fixture record, and the
real packaged index through the host io); brief snippet #2 verbatim plus the
configuration-change half; branding (plain-object clone, spread copy, caller-built source);
historical/conflicting/disjoint verdicts; the Gradle-cache adapter against a fixture
`GRADLE_USER_HOME` and `~/.gradle`; the source-purity gate and a whole-tree hash proving the
project is untouched.

---

## Packaging and CI notes for the release/integration owner

1. **`package.json.files` must gain `data/sdk-compatibility`** (not `data/`, `docs/` or
   `test/`). The loader resolves the index relative to `dist/declarationcontext.js`, so
   `scripts/verify-tarball.mjs`'s `derivedSiblingDirs()` now derives `data` as a required
   sibling directory (measured from the built `dist/`: `data, package.json, scripts`) — the
   tarball gate will be red until `files` is updated, which is the intended canary. Not edited
   here per ownership.
2. **New suite needing registration:** `test/declarationcontext.mjs` —
   `node --test test/declarationcontext.mjs` after `npm run build`. Like S1–S4's suites it runs
   in no workflow yet.
3. `readCompatibilityIndex()` / `indexedRecordPaths()` are the primitives S6's
   `verifySdkCompatibilityPayload(packageRoot)` can build on; note they resolve from THIS
   module's URL, so an installed-package canary should import the installed `dist/`.

---

## Behaviour changes worth naming

1. **`vault_api sdkVersion` is bounded.** A non-numeric label (`"missing-…"`, `"../x"`,
   `"0.13.3.4"`) now returns `status:"unavailable", code:"version-invalid"` with the managed
   setup guidance, instead of being joined into a path under `~/Library/PICO/sdk`. The existing
   `test/vault.mjs` case that passed a `missing-<pid>` label still passes (same status, same
   note requirements).
2. **Explicit vault roots must be absolute** (`vault_api vaultRoot`, `vault_diff from/to`).
   A relative spec is refused (`root-invalid` / structured error) rather than resolved against
   the server's cwd. `~/` is still expanded.
3. **The vault base honours the selected tools root** (`$PICO_HOME` before the documented
   default) for the default root, version labels and workspace enumeration. `PICO_AGENT_VAULT`
   still wins for the default. On non-darwin hosts without `PICO_HOME` the previous spelling
   is kept.
4. **Result shapes grew, nothing was removed:** `vault_api`, `vault_workspaces` and
   `vault_diff` results and the `preflight_lint.vault` block carry the fields described above.
   `vault_api`'s `not-found` note now names the declared revision instead of "SDK ?".
5. `loadVaultIndex`'s revision regex is the shared `parsePackageRevision` (tolerates whitespace
   between tags; the S4 sandbox cases still pass).

---

## Self-review

- **Completeness** — every checkbox in the brief and all seven controller resolutions have at
  least one test; both verbatim snippets are present character-for-character (only the file's
  indentation added, `target` bound to the resolved temp project and `recordPath`/`projectA`/
  `projectB`/`changedArtifactProject` defined immediately above them); the two-project reuse
  scenario includes both halves (changed artifact → applicability rejected; changed
  configuration → old binding rejected, fresh verification accepted with the same record hash).
- **Discipline** — `records` is empty; no measured mapping was manufactured; the fixture
  record uses a `com.pico.spatial.fixture` group, target BOM `9.9.9`, synthetic bytes and a
  synthetic basis, and every fixture string says so; the historical documents and fixture are
  unchanged vs base (`git diff --stat 69f7b48 -- docs/SDK_6_0_0_DRIFT.md
  test/fixtures/sdk-adoption-provenance.json` is empty); nothing was relabeled 6.1.
- **Verified: nothing infers a revision from a directory label** — the reader never looks at
  the path; workspaces report `version` (label) and `packageRevision` (declared) separately;
  the suite reads a vault at `/sdk/6.1/agent-vault` and gets `0.13.3` (and `unavailable`
  without package.xml).
- **Verified: caller JSON cannot add trust anchors** — unindexed paths, byte-identical copies
  at unindexed paths, a basis outside the index, a `recordPaths` hint through `vault_api`, and
  records carrying `compatible:true`/`binding`/`projectRoot` are all rejected; the public
  schemas of `vault_api` and `pico_sdk` are asserted to contain hint inputs only.
- **Verified: no CLI/Gradle/Java/service is invoked** — source-text gate on
  `src/declarationcontext.ts`; the integration only calls the S3 static reader and fs; the
  host artifact lookup is a read-only cache walk exercised against a fixture home.
- **Verified: `clean` semantics untouched** — the lint suite asserts
  `clean === (violations.length === 0 && counts.projectErrors === 0)` in every S5 case, and
  that a retained-lessons violation still makes `clean` false.
- **Hermeticity** — the unit suite touches the host only for temp projects, a temp Gradle
  home and reading the repository's own packaged data/originals/source; the vault/lint/vaultdiff
  blocks build temp vaults/projects and restore `PICO_AGENT_VAULT`. No new real-vault read was
  added (the existing `test/vault.mjs` real-vault block and the doors harness behave as before).

---

## Concerns

1. **`target-compatible` is unreachable through the tools today, by design.** `vault_api` and
   `preflight_lint` read the project with `readProjectSdkIdentity(projectRoot)` and never accept
   `resolvedArtifacts` from the caller (that would be a caller asserting what its project
   resolves — the same trust hole as a compatibility boolean). Until an SDK-owned resolution
   boundary supplies verified artifacts, every tool-level context is `historical`/`unknown`;
   the full path is proven at unit level with resolved identities. The report says so rather
   than pretending otherwise.
2. **The signature derivation is a commitment, not a signature parse.** `sourceSha256`/
   `targetSha256` bind a symbol to the verified declaration fingerprint, BOM and artifact
   sets, plus a presence check of the symbol in the listed source files. A reviewer producing
   a record must derive them with the exported helpers; the loader cannot extract Kotlin
   signatures from an AAR and does not claim to.
3. **`hostDeclarationIO.artifactPath` walks the Gradle module cache.** Read-only and bounded
   to `caches/modules-2/files-2.1/<group>/<artifact>/<version>`, but it is a host convention
   (documented in the drift measurement) rather than an SDK contract; a different cache layout
   simply yields `artifact-unavailable`. Not exercised against the real cache here.
4. **Fingerprint prefix.** Resolution 2's entry format is used exactly; I added the
   `pico-declaration-identity/1\n<authority>\n` prefix (mirroring S3's versioned prefix) so
   prose and declaration roots cannot collide. If the controller wants the bare material, it
   is a one-line change plus the pinned test.
5. **Project fixtures live on disk, not in the in-memory tree.** The brief lists
   `/project/gradle/libs.versions.toml` among the tree fixtures, but S3's reader is fs-bound and
   not mine to change, so projects are `mkdtemp` directories (as in S3's own suite) and the
   loader's project re-read always uses the real filesystem even when a `DeclarationIO` is
   injected. Documented in the module and the suite header.
6. **Two lint battery items and two distribution-adoption items are red on this branch** —
   the baseline inventory defect R3 fixed on the release track (`f8c78c7`), not yet merged
   here. Nothing in S5 touches those inputs.
7. **`vault.ts` grew by 219 lines** (940 → 1159, mostly the authority report and the
   `vault_api` handler); `lint.ts` by 19. Extracting the authority report into its own module
   would be a reasonable follow-up if the file keeps growing; I kept it in `vault.ts` because
   the brief places context threading there.
8. **Windows paths are untested** for the new module (posix fixtures on macOS); the reader
   normalizes relative paths to forward slashes and the host adapter uses `path.join`, but no
   win32 tree case exists yet.
9. **`pico_doctor {}` was not run** — the dispatch forbids MCP tool calls; the work is host-only
   TypeScript, fixtures and git.

---

# Fix round 1 (review items 1 and 2)

Same worktree/branch; base for this round `dde0669`. One commit (see below), trailer verified.

## Item 1 — a multi-match lookup was headlined `target-verified` on ANY verified match

Confirmed as reported: `symbolAuthorityOf` returned `target-compatible` when any passed symbol
was in `verifiedSymbols`, and the `ok` path passed `[...matchNames, wanted]` for up to five
matches, so one verified `Entity` beside an unverified same-named `Entity` from another package
put five typeCards under a `target-verified` headline.

**Change (`src/vault.ts`).** `symbolAuthorityOf` is replaced by
`lookupHeadline(authority, matchNames)` → `{symbolAuthority, lookup, verifiedMatches,
incompatibleMatches}`:
- `incompatible` if ANY returned match is in an applicable incompatible record's scope
  (unchanged, conservative);
- `target-compatible` only if EVERY returned match is in `verifiedSymbols` (and there is at
  least one match);
- otherwise `unknown`; `lookup` is `target-verified` only for those two verified verdicts,
  `historical` for everything else;
- `verifiedMatches` / `incompatibleMatches` list exactly the returned matches in each set.
The `ok` path now passes only the returned matches' qualified names (the raw query string is no
longer mixed in); `not-found`/`documented-only` pass `[wanted]` and therefore can never be
headlined verified. Every `vault_api` result (and `pico_sdk`, which forwards it) carries
`verifiedMatches` and `incompatibleMatches`.

## Item 2 — a missing packaged index must not read as "no reviewed records"

**Change (`src/vault.ts`, `src/lint.ts`).** `describeCompatibilityIndex(io?)` wraps
`readCompatibilityIndex` into a `CompatibilityIndexState`
`{status: "present"|"missing"|"invalid", path, code, detail, records}` (`missing` =
`index-missing`; `invalid` = `index-schema` or `evidence-hash`, with the code). It is threaded
through `describeDeclarationAuthority` (which now reads the index once itself instead of calling
`indexedRecordPaths`, and derives the indexed record paths from that read) into
`report.compatibilityIndex`, and reported as `compatibilityIndex` on every `vault_api` branch —
`version-invalid`/`root-invalid`, vault-not-found, `ok`, `documented-only`, `not-found` — on
`pico_sdk` (forwarded) and in the `preflight_lint.vault` advisory block. The unknown-linkage note
now says which it is: "the reviewed compatibility index is missing (index-missing: …), so
nothing can be verified" / "… is invalid (evidence-hash: …) …" / "the reviewed compatibility
index lists no records, so nothing verifies these 0.13.3 declarations" / "no reviewed
compatibility record verifies … Rejected records: …".

## TDD

RED first (tests written, run against the previous build `dde0669`):

```
$ node --test test/declarationcontext.mjs
✖ a multi-match lookup is headlined target-verified only when EVERY returned match is verified; a partial match stays unknown and names the verified ones
✖ a missing or invalid packaged index is reported distinctly from an index that lists no records
ℹ tests 23  ℹ pass 21  ℹ fail 2
$ node test/vault.mjs
  FAIL S5: the packaged index is present with no records (got undefined)
  FAIL S5: the note says the index lists no records, not that it is missing (got Target linkage UNKNOWN: no reviewed compatibility record verifies …)
  FAIL S5: no reviewed record -> no verified/incompatible matches and a historical headline (got {"lookup":"historical"})
  FAIL S5: every lookup branch reports the index state
  FAIL S5: the version-invalid branch still reports the packaged index state
Vault test done. Failures: 5
$ node test/lint.mjs
  FAIL S5: compatibilityIndex missing from the advisory block: undefined
Lint fixture test done. Failures: 4          # 3 of the 4 are the known R3-owned battery baseline
```

GREEN after `npm run build`:

```
$ node --test test/declarationcontext.mjs      # ℹ tests 23  ℹ pass 23  ℹ fail 0
$ node test/vault.mjs                          # Vault test done. Failures: 0
$ node test/vaultdiff.mjs                      # Vault-diff test done. Failures: 0
$ node test/lint.mjs                           # Lint fixture test done. Failures: 3  (battery baseline only; all S5 lines ok)
$ node test/doors.mjs                          # Doors test done. Failures: 0
```

Mutation check (each built, run, restored byte-identically, rebuilt):

| Mutation of `src/vault.ts` | Result |
| --- | --- |
| headline back to ANY verified match (`verifiedMatches.length > 0`) | fail=1: the multi-match test |
| index state always reported `present` | fail=1: the missing/invalid-index test |

## Tests added

- `test/declarationcontext.mjs` §6 (2 cases, +116 lines): a two-package vault declaring `Entity`
  twice with one indexed record scoped to `com.pico.spatial.core.ecs.Entity` — a real
  reader/loader/resolver tuple, not a hand-built authority — asserts a partial match is
  `unknown`/`historical` with `verifiedMatches` naming only the scoped one, the all-verified
  case is `target-compatible`/`target-verified`, no matches is never verified, an incompatible
  record scoped to the other `Entity` headlines `incompatible` with `incompatibleMatches`
  naming it, no target is `historical`, an unavailable identity is `unavailable`. The index
  case drives `describeDeclarationAuthority` through the injection seam with: a present index
  and no records (`present`, 0, note "lists no records"), a missing index (`missing`,
  `index-missing`, note says missing, never "lists no records"), a tampered historical
  reference (`invalid`, `evidence-hash`), a malformed index (`invalid`, `index-schema`), a
  present index with one record against a declared-only project (`present`, 1,
  `target-unresolved`, note "Rejected records: target-unresolved"), a caller record path under a
  missing index (`missing` + `record-not-reviewed`), and no target (`missing` + `historical`).
- `test/vault.mjs` (+7): `compatibilityIndex` present/0/null on the bound, no-target, not-found
  and version-invalid results; the note says "lists no records"; `verifiedMatches` and
  `incompatibleMatches` are `[]` with a `historical` headline.
- `test/lint.mjs` (+2): the advisory block reports `compatibilityIndex` present/0/null.

Handler-level positive/partial headlines remain untestable through `vault_api` for the reason
in concern 1 (no SDK-owned resolution boundary supplies `resolvedArtifacts`), so the every-match
rule is proven on `lookupHeadline` with real branded evidence and the handler is proven to pass
only returned match names.

## Files changed in this round

```
 src/lint.ts                 |   1 +
 src/vault.ts                | 131 +++++++++++++++++++++-----------   (1159 -> 1231 lines)
 test/declarationcontext.mjs | 116 ++++++++++++++++++++++++
 test/lint.mjs               |   2 +
 test/vault.mjs              |   7 +
```

No other ledgered Minor item was touched. `symbolAuthorityOf` no longer exists (nothing else
consumed it); `indexedRecordPaths` remains exported from `declarationcontext.ts` for S6.
