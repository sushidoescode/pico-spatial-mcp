# Task S3 — Preserve project dependency identity during generation

Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-sdk-2026-09-15` (branch `track/cli050-sdk`)
Commit: `524e606` — `fix: preserve project BOM while recording toolchain selection`
Base: `d708fdb` (S1 + S2 + their fix rounds). Not pushed. Trailer verified on the commit object.

## What I implemented

### `src/projectidentity.ts` (new, 458 lines) — the pure static reader

Imports `node:crypto`, `node:fs` and `node:path` and nothing else. It opens files; it starts no
process, runs no Gradle, contacts no network and writes nothing. `test/projectidentity.mjs` asserts
that as a source-text gate (no `child_process` / `execFile` / `execSync` / `spawnSync` / `spawn(` /
`sdk-facts` / `gradlew` / `./toolchain.js` / `node:http`) and, separately, hashes the whole fixture
tree before and after a read to prove the reader is read-only.

```ts
export interface ProjectSdkIdentity {
  projectRoot: string; fingerprint: string;
  declaredBom: string | null; resolvedArtifacts: readonly {coordinate:string; sha256:string}[];
  status: "declared" | "resolved" | "unknown"; reasons: readonly string[];
}
export function readProjectSdkIdentity(projectRoot: string, options?: ProjectSdkIdentityOptions): ProjectSdkIdentity;
export const PROJECT_IDENTITY_FILES: readonly string[];   // the bounded allowlist
```

**Allowlist** (controller resolution 1, sorted, all project-relative, asserted as an exact list):
`app/build.gradle`, `app/build.gradle.kts`, `build.gradle`, `build.gradle.kts`, `gradle.properties`,
`gradle/libs.versions.toml`, `settings.gradle`, `settings.gradle.kts`. A stray
`build/libs.versions.toml` is not read and does not move the fingerprint — the suite asserts both.

**Supported declaration forms.**

1. The exact shape `appskeleton/gradle/libs.versions.toml` ships — line 5 `bom = "6.0.0"` in
   `[versions]`, referenced by line 14 `bom = { group = "com.pico.spatial", name = "bom",
   version.ref = "bom" }` in `[libraries]`, and consumed at `appskeleton/app/build.gradle.kts:50`
   as `implementation(platform(libs.bom))`. A catalog alone yields `declared`; the build-file
   reference is not required.
2. A literal Gradle coordinate `platform("com.pico.spatial…:…:X.Y.Z")` (and `enforcedPlatform`,
   Kotlin or Groovy, single or double quotes) with no catalog at all.
3. The `implementation(platform(libs.<alias>))` pair, which resolves through form 1. This is also
   how a PICO BOM entry whose artifact is not literally named `bom` is found — matching is on
   `group` starting `com.pico.spatial` plus either `name === "bom"` or an alias a `platform(...)`
   call actually references. Catalog aliases are matched with `-`, `_` and `.` normalised, because
   Gradle's accessor `libs.pico.platform` is the alias `pico-platform`.

**Everything else is `unknown` with file-specific reasons** — `+`, `6.0.+`, `[6.0,7.0)`,
`latest.release`, `6.0.0-SNAPSHOT`, `$bomVersion` interpolation, `project.findProperty(...)`, a
`version.ref` with no matching `[versions]` entry, a rich constraint `{ require = "6.0.0" }`, a
BOM entry with no version, conflicting declarations across files (both files AND both versions are
named in the reason), a missing catalog, an absent/unreadable root, and a `settings.gradle(.kts)`
that declares its own `versionCatalogs { ... }` source — in that last case the catalog we can see
may not be the one Gradle reads, so catalog evidence is suppressed with a reason rather than
trusted. A literal declaration standing beside an unreadable one is also `unknown`: one readable
declaration does not make the other agree with it.

Comments are blanked quote-aware (`#` for TOML, `//` and `/* */` for Gradle) before any scanning,
so a commented-out `platform("com.pico.spatial:bom:9.9.9")` is not a declaration and the `//` in a
quoted `https://artifact.bytedance.com/...` repository URL is not a comment. Both have tests.

**`fingerprint`** is sha256 over a versioned prefix plus, for each allowlisted file that exists,
`${rel}\0${sha256(bytes)}\n` in sorted relative-path order. A present-but-unreadable file
contributes a distinct `unreadable` marker so it cannot masquerade as an absent one. Per resolution
1 the canonical root is kept **separate** and reported as `projectRoot` (realpath'd, falling back to
`path.resolve`), so the fingerprint is *content* identity: two checkouts of one project agree on
`fingerprint` and differ on `projectRoot`, which is what makes the pair usable as a cache key. Two
projects that declare nothing also agree — correctly, their declared identity really is the same
emptiness — and that property is asserted rather than left accidental, with `status: "unknown"`
alongside it. The module comment states the pairing requirement explicitly (the S1 lesson about a
constant identity).

**`resolvedArtifacts`** stays `[]` unless a caller passes verified evidence through the explicit
`readProjectSdkIdentity(root, {resolvedArtifacts})` boundary; it is never derived here, because only
a real resolution can produce it. Supplied evidence is validated (`coordinate` a non-empty string,
`sha256` 64 lowercase hex) and *refused* with a reason rather than upgraded when malformed, the
result holds its own frozen copy (mutating the caller's array afterwards does not change it), and an
empty list is simply no evidence. Only non-empty verified evidence raises `status` to `resolved`;
the declaration is still reported beside it.

### `src/toolchainselection.ts` — `serializeJavaProperty` (resolution 3)

A pure ~35-line addition beside `parseJavaProperties`, implementing `java.util.Properties.store`'s
`saveConvert`: chars in `(61,127)` pass through except `\` → `\\`; `=`, `:`, `#`, `!` are escaped;
`\t \n \r \f` are escaped; keys escape every space, values only a **leading** space; everything
outside printable ASCII becomes `\uXXXX`. That last rule also makes the written file
byte-encoding-independent, which matters because Gradle reads `local.properties` with
`Properties.load`. The result is always one physical line — no accidental continuation or comment.
No new imports, so S1's purity gate on this module still holds.

### `src/projectgen.ts` (resolution 2)

- `GenerateOptions.toolchain?: SelectedToolchain`. **Supplied** → used as-is, its `root` is what
  lands in `local.properties`. **Absent** → resolved once via
  `resolveHostToolchain({required:["packer"]})`.
- `requireUsableSelection()` validates the selection **at runtime** (a selection arrives from a tool
  input as much as from TypeScript) and throws a structured message carrying the resolver's own
  `code`/`detail` — placed after the existing skeleton/target/package guards and **before** the
  destination is created, so an unusable toolchain never leaves a half-written project behind.
- `GenerateResult` gains `toolchain: SelectedToolchain` and
  `templateBom: {declaredBom: string|null; catalogSha256: string}`. `declaredBom` comes from
  `readProjectSdkIdentity(SKELETON_ROOT)`; `catalogSha256` is the hash of the **generated** copy.
  For that field to *prove* preservation rather than just report a number, the generator hashes the
  template catalog before the copy and throws if the generated one differs — "generation rewrote
  gradle/libs.versions.toml … the project BOM must be copied verbatim". Nothing in the generator can
  now change the BOM silently.
- `local.properties` is written through `serializeJavaProperty` for both `sdk.dir` and
  `spatial.tools.dir`. For an ordinary ASCII root the bytes are unchanged, so the file's existing
  shape and the determinism test are preserved.

### `src/scaffold.ts` (resolution 4)

- `applyToolsDirProperty(existing, toolsRoot) -> {content, previousToolsDir, appliedToolsDir}`,
  exported so it can be tested without spawning a server and running rsync. It finds existing
  declarations by **parsing** rather than by matching literal text, because `spatial\.tools\.dir : /x`,
  a whitespace separator and a backslash-continued value are all the same key to Gradle — a regex
  rewrite leaves those behind as duplicates, and a duplicate key is exactly the
  `ambiguous/property-conflict` the S1 resolver refuses to answer. Every other line, `sdk.dir` above
  all, is preserved byte-for-byte. Duplicate declarations that **disagree** report
  `previousToolsDir: null` rather than an arbitrary one of them.
- The clone path resolves one `resolveHostToolchain({required:["packer"]})` after the existing
  template validation and **before** `rsync`, failing structurally rather than cloning against tools
  that are not there. It reports `toolchain`, `previousToolsDir` and `appliedToolsDir`.
- The catalog, the BOM and the dependency repositories are untouched in both paths. The generated
  path's result also discloses `toolchain`, `appliedToolsDir` and `templateBom`.

## TDD evidence

### RED 1 — the suites exist, the module does not

```
$ npm run build && node --test test/projectidentity.mjs
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///…/dist/projectidentity.js'
ℹ tests 1  ℹ pass 0  ℹ fail 1

$ node test/projectgen.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/dist/projectidentity.js'
```

### RED 2 — the missing generation-provenance failure (retained)

`src/projectidentity.ts` and `serializeJavaProperty` in place, `src/projectgen.ts` / `src/scaffold.ts`
still pre-S3:

```
$ npm run build && node test/projectgen.mjs
  FAIL spatial.tools.dir is not the supplied root: # Generated by pico-spatial-mcp (machine-specific — do not commit).
sdk.dir=/Users/sushantsrikrish/Library/Android/sdk
spatial.tools.dir=/Users/sushantsrikrish/Library/PICO/sdk
  FAIL GenerateResult.toolchain drifted: undefined
  FAIL templateBom wrong: undefined
  FAIL local.properties does not round-trip "C:\\Program Files\\PICO\\sdk": value="/Users/sushantsrikrish/Library/PICO/sdk"
  FAIL local.properties does not round-trip "/Volumes/Team Drive/PICO #1/sdk": value="/Users/sushantsrikrish/Library/PICO/sdk"
  FAIL local.properties does not round-trip "/Users/té st/Library/PICO/sdk": value="/Users/sushantsrikrish/Library/PICO/sdk"
  FAIL local.properties does not round-trip "\\\\build\\share\\pico=tools": value="/Users/sushantsrikrish/Library/PICO/sdk"
  FAIL invalid selection not refused before creating …/rejected (threw=false, exists=true)
  FAIL host-resolution failure not structural: undefined exists=true
TypeError: Cannot read properties of undefined (reading 'status')   # hostGen.toolchain
```

Three separate defects visible in one run: the caller's selection was ignored entirely, the
generator's own host lookup **leaked this machine's `~/Library/PICO/sdk` into every generated
project** regardless of what the caller chose (the same host-env leak S2 found in `preflight.ts`),
and no provenance was reported at all. A non-`ok` selection also silently produced a project.

### RED 3 — mutation testing, because `test/projectidentity.mjs` was green on its first implementation run

A suite that passes the moment the code exists has not been shown to gate anything. Four mutations
of `src/projectidentity.ts`, each built and run, each restored afterwards:

| Mutation | Result |
| --- | --- |
| `LITERAL_VERSION` accepts anything | ✖ 2 fail — dynamic providers, property interpolation |
| canonical root hashed into the fingerprint | ✖ 2 fail — cross-root agreement, empty-project pair |
| comment stripping disabled | ✖ 1 fail — commented-out declarations |
| `resolvedArtifacts` derived from the declaration | ✖ 7 fail — every `declared` case plus the evidence boundary |

### GREEN

```
$ npm run build                                              # tsc, strict, clean
$ node --test test/projectidentity.mjs                       # ℹ tests 24  pass 24  fail 0
$ node test/projectgen.mjs                                   # Failures: 0  (61 ok, was 39)
$ node --test test/toolchain-resolution.mjs test/toolchain-consumers.mjs   # ℹ tests 76  pass 76  fail 0
$ node test/preflight.mjs                                    # Preflight test done. Failures: 0
$ node test/doors.mjs                                        # Doors test done. Failures: 0
$ npm run test:unitygen                                      # Unitygen test done. Failures: 0
$ npm run test:prompts                                       # ℹ tests 3  pass 3  fail 0
```

One genuine in-flight correction: my first cross-root assertion in `test/projectgen.mjs` compared
two projects generated with **different package names**, whose `settings.gradle.kts` and
`app/build.gradle.kts` genuinely differ, so the fingerprints genuinely differed. The assertion was
wrong, not the reader. It now generates the *same* project against a *different* toolchain on a
*different* root — which is the property the task is actually about — and a third case renames the
package to prove the comparison is not vacuous.

## What the tests cover

**`test/projectidentity.mjs`** (24 `node --test` cases, real temp projects on disk): both declared
forms plus Groovy/`enforcedPlatform`/non-`bom` artifact variants; the packaged skeleton itself,
cross-checked against the literal catalog line the test re-reads; five dynamic version spellings;
`$var` and `project.findProperty` interpolation; missing and non-literal `version.ref`; a rich
constraint; cross-file conflict naming both files and both versions; no catalog; absent root;
relocated `versionCatalogs`; commented-out declarations; a repository URL that must not be read as a
comment; the fingerprint's stability, allowlist coverage (every file feeds it, restoring the bytes
restores it, deleting a file changes it), and immunity to everything outside the allowlist; content
identity across two roots; the empty-project pair; the exact allowlist; a hostile path
(space + non-ASCII); the `resolvedArtifacts` boundary including copy semantics and four malformed
shapes; the source-purity gate; and a whole-tree hash proving the reader writes nothing.

**`test/projectgen.mjs`** (61 assertions, was 39 — every pre-existing one kept, including package
renaming and the `strings.xml` / manifest resource-escaping shapes): the supplied root lands
verbatim; `GenerateResult.toolchain` is the exact selection; `templateBom`; four hostile tool roots
round-tripped through the generated file; nine direct `serializeJavaProperty` ↔ `parseJavaProperties`
round trips (drive letter, spaces, leading space, trailing backslash, non-ASCII, `=:!#`, empty
key/value); an invalid selection refused before the destination exists; an unresolvable host
toolchain refused before the destination exists (`PICO_HOME` pointed at an empty tree, saved and
restored); host resolution succeeding against a fixture tree; ten `applyToolsDirProperty` shapes
including colon and whitespace separators, an escaped key, a continued value, a commented-out key
and agreeing/disagreeing duplicates; cross-root BOM+fingerprint identity under two different
toolchains; the renamed-project counterexample; a source scan proving `src/projectgen.ts` spawns
nothing; and the brief's regression verbatim.

The existing calls in `test/projectgen.mjs` now pass `toolchain: selected61`. That was necessary —
without it, generation resolves the host toolchain, so the suite would have depended on this
machine's `~/Library/PICO/sdk` and gone red on CI, and the two guardrail cases would have thrown for
the wrong reason. The suite is now hermetic with respect to the host SDK, except the two blocks that
deliberately set `PICO_HOME` at a fixture tree they create themselves. No fixture binary is ever
executed (files are written mode `0o755` and only stat'd).

## Files changed

```
 src/projectgen.ts         |  72 ++++++++++---     (modified)
 src/projectidentity.ts    | 458 +++++++++++++     (new)
 src/scaffold.ts           |  80 ++++++++++---     (modified)
 src/toolchainselection.ts |  41 +++++++          (modified: serializeJavaProperty only)
 test/projectgen.mjs       | 213 ++++++++++++++    (modified)
 test/projectidentity.mjs  | 320 ++++++++++++++    (new)
```

Nothing outside the ownership boundary: no `package.json`, `package-lock.json`, `.gitignore`,
`.github/**`, `scripts/**`, `test/distribution-adoption.mjs`, README/AGENTS/policy docs,
`src/preflight.ts`, `src/bundle.ts`, `src/editor.ts`, `src/workflow.ts`, `src/adb.ts`, `src/grpc.ts`,
`src/vault*.ts`, `src/lint.ts`, `src/doors.ts`, `src/picocli*.ts`, `src/knowledge.ts`, or the JDK
cache. `src/toolchainselection.ts` gained only the serializer beside the parser, as permitted.

## New test file needing CI registration

- **`test/projectidentity.mjs`** — `node --test test/projectidentity.mjs`, requires `npm run build`
  first (it imports `dist/`). No `package.json` script was added, per the ownership boundary. It
  should be registered alongside S1's `test/toolchain-resolution.mjs` and S2's
  `test/toolchain-consumers.mjs`, which are also still unregistered.
- `test/projectgen.mjs` already runs as `npm run test:projectgen`; no registration change.

## Behaviour changes worth naming

1. **`scaffold_spatial_app` now fails on a host with no usable packer**, in both the generated and
   the clone path, instead of writing a project whose `spatial.tools.dir` points at a directory that
   does not exist. This is what resolution 2 asks for, and the failure is structured (the resolver's
   own code and detail). The two internal callers already handle it: `src/hybridbuild.ts:79` and
   `src/fleetbuild.ts:1010` both branch on `!sc.created` and record a note. `scripts/verify-tarball.mjs`
   is unaffected — it calls `verifySkeleton()` and reads constants, never `generateSpatialProject`.
2. **Generation no longer consults `resolveToolsRoot()`.** It uses the component-valid S1 selection,
   so a host carrying an SDK directory with no packer payload is now refused rather than written
   into a project. `resolveToolsRoot` remains for `adb.ts`, `emulator.ts` and `grpc.ts` (not my files).
3. **The clone path's `local.properties` rewrite is stricter.** It removes every parsed declaration
   of the key rather than the first regex-matching line, so a file with a duplicate or escaped key
   comes out with exactly one. Other lines are byte-preserved; a CRLF file's final line terminator is
   normalised to `\n` where the new key is appended (the rest keep their CRLFs, and `Properties.load`
   accepts both).
4. **The clone path's package-string replacement still passes over `.toml` files** (pre-existing
   `TEXT_EXT` behaviour). That is a package rename, not a BOM or repository change, and I deliberately
   did not alter it — it is the clone's purpose. No code path rewrites a version or a repository URL.

## Self-review findings

- **Completeness** — every brief checkbox and all five controller resolutions have at least one test;
  the brief's regression snippet appears verbatim (only the file's own two-space indentation added),
  using a literal valid `SelectedToolchain` for `selected61` and the file's existing
  package/appName/stageStyle fixture with a fresh destination in the same sandbox.
- **Two defects the tests caught in my own work** — the wrong cross-root assertion described above,
  and a false-positive source scan that banned the substring `gradlew"`, which `src/projectgen.ts`
  legitimately contains as a file it *copies and chmods*. The scan now bans `./gradlew` and the
  process APIs, with the reason recorded in a comment.
- **Verified: no code path runs Gradle** — asserted as a source gate on both `src/projectidentity.ts`
  and `src/projectgen.ts`, and structurally true (neither imports `node:child_process`). The only
  `execFileSync` in scope is `src/scaffold.ts`'s pre-existing `rsync`, untouched.
- **Verified: no code path modifies the catalog** — the generator hashes the template catalog before
  the copy and throws if the generated bytes differ, and the brief's regression deep-equals the two
  buffers. The clone path never writes to it.
- **Verified: existing package-renaming and resource-escaping tests remain intact** — the
  `app_name` XML-escape assertion, the two rebrand-regex shape assertions, the manifest stage-style
  substitution, the residue walk and the determinism pair all still run and pass unmodified.
- **Hermeticity** — both suites build their own temp projects and remove them (`test.after` /
  `finally`). `test/projectidentity.mjs` reads two real repo paths deliberately: `appskeleton/` (to
  assert the packaged skeleton's own declaration) and `src/projectidentity.ts` (the purity gate).
  `test/projectgen.mjs` sets `PICO_HOME` only inside a `try/finally` that restores it, including the
  unset case.
- **Discipline** — no Gradle execution, no BOM rewrite, no dependency-repository change, no new
  dependency, no persistent pin format, no caching layer. `src/projectidentity.ts` is the reader;
  `projectgen`/`scaffold` consume it and the selection. The serializer is 35 lines beside the parser
  it inverts.

## Concerns

1. **The declaration grammar is deliberately narrow.** A project declaring its BOM through
   `buildSrc`, a convention plugin, a settings-level `dependencyResolutionManagement` constraint, an
   included build, or a catalog file at a non-default path reports `unknown`. That is the correct
   fail-closed answer for a static reader, but a consumer (Task 5) should treat `unknown` as "ask a
   resolution", not "no BOM".
2. **`status: "resolved"` is reported even when the declaration is conflicting or unreadable**, with
   the declaration problem recorded in `reasons`. Verified resolved evidence is strictly stronger
   than a declaration, so this is intentional — but a caller that only reads `status` will not see
   the declaration defect. `reasons` is where it lives.
3. **No `ProjectSdkIdentity` is threaded into `GenerateResult`.** Generation reports
   `templateBom` (the template's declared BOM and the copied catalog's hash), not a full identity for
   the generated project, because the brief specifies exactly those two fields. A caller that wants
   the full record calls `readProjectSdkIdentity(result.created)` — which is what the regression does.
4. **`readProjectSdkIdentity(SKELETON_ROOT)` runs on every generation** (eight small file reads plus
   two catalog hashes). Unmeasured but trivially bounded; I did not add a cache.
5. **Windows behaviour is fixture-only.** Drive letters, UNC roots and backslash escaping are proven
   against literal strings on a macOS host. This establishes the serializer's correctness against
   `parseJavaProperties`, not real Windows filesystem or Gradle behaviour.
6. **`test/projectidentity.mjs` runs in no workflow yet** — same trap AGENTS.md records for
   `test:runrevision`, and the same note S1 and S2 filed for their suites.
7. **No native, device, emulator, Gradle or visual evidence** is claimed or applicable. Nothing here
   was run against the real SDK, a packer, an emulator or a build. Every result above is host-only,
   fixture-backed unit evidence. The recommended follow-up, when a task is permitted to build, is a
   single `scaffold_spatial_app` + `./gradlew :app:dependencies` on the generated project, confirming
   that the resolved PICO BOM equals the `declaredBom` this reader reports.
8. **`pico_doctor {}` was not run.** This task's dispatch forbids MCP tool calls; the work is
   host-only TypeScript, tests and git, so no environment gate applied.
