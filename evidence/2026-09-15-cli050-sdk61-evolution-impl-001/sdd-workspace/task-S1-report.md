# Task S1 — Define component-valid project/host selection

Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-sdk-2026-09-15` (branch `track/cli050-sdk`)
Commit: `bde4098` — `fix: unify component-aware PICO tool selection`
Base: `4478238`. Not pushed.

## What I implemented

### `src/toolchainselection.ts` (new, 612 lines) — pure resolver
Imports only `node:crypto` and `node:path`. Every filesystem observation arrives through the
injected `ToolchainIO`, so the module starts no process, contacts no registry and provisions
nothing.

Exports exactly the brief's surface — `ToolComponent`, `RootSource`, `ToolchainRequest`,
`FileIdentity`, `SelectedToolchain`, `ToolchainSelection`, `ToolchainIO`, `resolveToolchain`,
`executableNames` — plus the pieces `src/toolchain.ts` needs to build adapters on top:
`TOOL_COMPONENTS`, `TOOLS_DIR_PROPERTY`, `isVersionToken`, `compareVersions`,
`parseJavaProperties`, `resolveRootCandidate`, `scanInstallations`, `selectInstallation`,
`registerDefaultToolchainIO`.

Behaviour:

- **Root order** — explicit `toolsRoot` → project `local.properties[spatial.tools.dir]` →
  `PICO_HOME` → documented platform default. A *declared* root (the first three) that cannot be
  listed returns `unavailable/root-unavailable`; it never slides to the next source. A blank
  `PICO_HOME` is not a declaration. `~` expands against `io.home`; a relative project value
  resolves against `androidProjectRoot`.
- **Documented defaults** — only `darwin` → `<home>/Library/PICO/sdk`. `linux`, `win32` and
  anything else return `unavailable/unsupported-default-root` and probe nothing, so no invented
  path leaks into the detail string.
- **Components** — `packer` → `editor/spatialbundle/<spatialbundle>`, `emulator` →
  `emulator/<emulator>`, `adb` → `emulator/system-images/platform-tools/<adb>`, `proto` →
  `emulator/lib/emulator_controller.proto`. Executable components must pass `io.executable`;
  `proto` must be readable. `executableNames(name, "win32")` → `["<name>.exe"]`, bare name
  elsewhere, probed in order.
- **Component validity** — a selection is only `ok` when *every* requested component resolved
  from *one* installation. Explicit versions and project pins fail closed
  (`unavailable/component-missing`); automatic selection walks down from the newest install that
  carries the whole set.
- **Version tokens** — `^\d+\.\d+(?:\.\d+)?$`, validated verbatim with no trimming, so `" 6.1 "`,
  `"6.1\n"`, `"../6.1"`, `"6.1/"`, `"6.1\\"` and `"latest"` are all `unavailable/version-missing`.
  Only `undefined` / `""` mean "unpinned". Directory entries failing the same test are skipped
  rather than traversed.
- **Aliases** — directory names sharing a numeric key (`6.1` / `6.1.0`) are one installation when
  their required payloads are the same file (`io.realpath`) or the same bytes; otherwise
  `ambiguous/version-alias-conflict`. An exact directory-name request selects that directory.
  Component validity is judged *before* ambiguity, so two equally useless spellings report
  `component-missing`, not an ambiguity.
- **Properties parsing** — real `java.util.Properties` semantics: `#`/`!` comments, `=` / `:` /
  whitespace separators, `\t \n \r \f \\ \: \= \# \! \<space>` and `\uXXXX` escapes, logical lines
  joined across a trailing odd backslash with the continuation's leading whitespace stripped, BOM
  and CRLF handled. Duplicate `spatial.tools.dir` keys with different values →
  `ambiguous/property-conflict`; identical duplicates are fine.
- **Identity** — sha256 over `${component}\0${path-relative-to-root}\0${sha256}\n` for each
  selected required component in sorted component order (`adb, emulator, packer, proto`), with
  separators normalised to `/`. Only the selected required payloads are read; nothing else is
  hashed. A relocated install with identical bytes keeps its identity; changed bytes or a
  different required set change it.

### `src/toolchain.ts` (modified, lines 1–92 replaced)
- Owns `hostToolchainIO()`, the production `ToolchainIO` built from `fs` / `os` / `process`, and
  registers it as the resolver's default at import time.
- `resolveToolsRoot`, `listVersions`, `pickVersion` are now compatibility adapters over
  `resolveRootCandidate` / `scanInstallations` / `selectInstallation`. Signatures and return
  shapes are unchanged, so `adb.ts`, `bundle.ts`, `editor.ts`, `emulator.ts`, `grpc.ts`,
  `projectgen.ts`, `scaffold.ts`, `workflow.ts` and `validateToolchain` compile and run untouched
  (Task S2 migrates them).
- The adapters deliberately avoid `resolveToolchain`, so a `pickVersion` on the hot path never
  reads a multi-megabyte binary just to choose a version.
- `validateToolchain`, `emulatorLibDir`, `findAdb` and the JDK cache (Task S4) are untouched.

### Test files (new)
- `test/helpers/toolchain-fixture.mjs` (157 lines) — `toolchainIOFromTree({platform, home, env,
  files})` plus optional `dirs`, `symlinks`, `unreadable`, and a `macSdkTree()` shorthand.
  Imports only `node:path`; directories are derived from the declared paths; `entries` is sorted;
  win32 trees are case-insensitive like the real filesystem; `io.reads` records every path passed
  to `read` in call order. No host filesystem access, and an "executable" is a boolean flag — no
  fixture binary is ever run.
- `test/toolchain-resolution.mjs` (681 lines, 40 `node --test` cases).

## Behaviour change callouts (intentional)
1. `pickVersion(root, "6.1", "emulator")` now returns `null` when 6.1 ships no emulator payload.
   This is the defect being fixed; consumers already handle `null` (`sel?.version`, `if (!sel)`).
2. `listVersions` no longer lists a stray *file* named like a version, nor a version directory it
   cannot read.
3. `local.properties` is now parsed properly instead of by one regex, so `:` and whitespace
   separators and escapes take effect (matching what Gradle's `Properties.load` already did).
4. `resolveToolsRoot` has no failure channel, so a `local.properties` with *conflicting* duplicate
   `spatial.tools.dir` values degrades to `DEFAULT_TOOLS_ROOT`/`default` there; only
   `resolveToolchain` reports `ambiguous/property-conflict`. Documented in the adapter comment.

## What I tested and the results

`node --test test/toolchain-resolution.mjs` — **40 pass, 0 fail**. Coverage by checkbox:

- brief's three-assert regression, verbatim;
- one case per contract failure code (`component-missing`, `version-missing`, `root-unavailable`,
  `version-conflict`, `version-alias-conflict`, `unsupported-default-root`, `property-conflict`);
- numeric ordering (6.10 > 6.9 > 6.2); split components cannot mix 6.0/6.1; newest-usable skips a
  newer install lacking the component;
- explicit/pin fail-closed, `reason` = `explicit` / `project-pin` / `newest-usable`, agreeing
  explicit+pin is not a conflict;
- all four components from their documented subdirectories; a non-`chmod +x` payload does not
  satisfy an executable component;
- 14 rejected version tokens plus the empty-string-is-not-a-pin case; non-version directory names
  skipped;
- missing / empty / unreadable root, unreadable version directory, stray file named like a
  version;
- full root precedence chain and fail-closed behaviour for a declared-but-missing project value
  and `PICO_HOME`; a project with no `local.properties` or no property continues down the chain;
- 11 `local.properties` shapes (separators, comments, continuation, escaped space, `\uXXXX`,
  escaped key dots, CRLF, trailing blanks), escaped `\:`/`\\` Windows root, relative value, `~`
  value, conflicting vs identical duplicates;
- alias conflict, exact-name disambiguation, symlink alias (not a conflict), byte-identical copies
  (not a conflict), component validity before ambiguity;
- `executableNames` for all three names on win32/darwin/linux/freebsd; Windows drive root, a
  win32 tree with extensionless binaries (rejected), UNC root, case-insensitive win32 env key
  (and case-*sensitive* posix env key), explicit Linux root, unsupported defaults probing nothing,
  paths with spaces;
- identity: only required payloads read, deterministic, order-independent, content-sensitive,
  required-set-sensitive, root-relative;
- a source-text gate asserting `src/toolchainselection.ts` references no `child_process`,
  `node:fs`, `node:os`, `node:http(s)`, `fetch(`, `execSync` or `spawnSync`;
- legacy adapters against a throwaway `os.tmpdir()` tree (`listVersions` shape/order,
  `pickVersion` component-awareness for every `need`, empty-root guard, `resolveToolsRoot`
  precedence with `PICO_HOME` saved/restored).

Regression, after a rebuild:
- `node test/preflight.mjs` → `Preflight test done. Failures: 0`
- `node test/projectgen.mjs` → `Projectgen test done. Failures: 0`
- `npm run build` (`tsc`, strict) → clean, no output.

## TDD evidence

### RED 1 — missing export
```
$ npm run build && node --test test/toolchain-resolution.mjs
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-sdk-2026-09-15/dist/toolchainselection.js'
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

### RED 2 — behavioural failure against the legacy requested-version component behaviour
After `src/toolchainselection.ts` existed but `src/toolchain.ts` was still the pre-S1 file:
```
$ npm run build && node --test test/toolchain-resolution.mjs
ℹ tests 39
ℹ pass 37
ℹ fail 2

✖ legacy adapters are component-aware and keep their shape
  AssertionError [ERR_ASSERTION]: 6.1 ships no emulator payload
  + actual - expected
  + {
  +   emulatorBin: null,
  +   hasEditor: true,
  +   hasEmulator: false,
  +   spatialbundle: '/var/folders/.../pico-toolchain-s1-9VYfbk/6.1/editor/spatialbundle/spatialbundle',
  +   version: '6.1'
  + }
  - null

✖ version tokens must be two- or three-part numerals; everything else is rejected
  AssertionError [ERR_ASSERTION]: token "6.1\n" must not select anything
  + 'ok'  - 'unavailable'
```
The first failure is the defect this task exists to fix: `pickVersion(root, "6.1", "emulator")`
handed back the 6.1 install whose `emulatorBin` is `null`. The second was a real defect in my own
first draft — I trimmed the version token before validating it, so `"6.1\n"` and `" 6.1 "`
resolved. Fixed by validating tokens verbatim (resolution 2 lists whitespace as a rejected
character, so trimming was wrong).

### GREEN
```
$ npm run build && node --test test/toolchain-resolution.mjs
ℹ tests 40
ℹ pass 40
ℹ fail 0
```

## Files changed
```
 src/toolchain.ts                   | 147 +++++---      (modified: lines 1-92 replaced)
 src/toolchainselection.ts          | 612 ++++++++++     (new)
 test/helpers/toolchain-fixture.mjs | 157 ++++++        (new)
 test/toolchain-resolution.mjs      | 681 ++++++++++++   (new)
 4 files changed, 1553 insertions(+), 44 deletions(-)
```
Nothing outside the ownership boundary was touched: no `package.json`, `package-lock.json`,
`.gitignore`, `.github/**`, `scripts/**`, `test/distribution-adoption.mjs`, `README.md`,
`AGENTS.md`, `src/preflight.ts`, `src/picocli*.ts`, `src/knowledge.ts`, `src/doors.ts`,
`src/vault*.ts`, `src/lint.ts`, `src/adb.ts` or `src/grpc.ts`.

## New test file needing CI registration
- `test/toolchain-resolution.mjs` — run with `node --test test/toolchain-resolution.mjs`
  (requires `npm run build` first; it imports `dist/`). No `package.json` script was added, per
  the ownership boundary; the release track should register it in the CI inventory
  (`gates.yml` + whatever `test/distribution-adoption.mjs` expects).
- `test/helpers/toolchain-fixture.mjs` is a helper, not a suite — no registration needed.

## Self-review findings
- **Completeness** — every checkbox in the brief has at least one test, and every row of the
  contract table (including the added `ambiguous/property-conflict`) has a dedicated assertion in
  "every contract failure code is reachable with its documented trigger".
- **Two defects found by the tests, not by inspection** — the token-trimming bug above, and
  ambiguity being evaluated before component validity (two alias directories that both lack the
  requested component reported `version-alias-conflict` instead of `component-missing`). Both
  fixed; the second has its own test using the `06.1` / `6.1.0` spelling pair, the only way the
  case is reachable.
- **Hermetic** — the fixture helper imports only `node:path`. The suite touches the real
  filesystem in exactly two documented places: the `os.tmpdir()` tree used for the legacy-adapter
  block (the adapters are hard-wired to `fs`), and reading `src/toolchainselection.ts` as text for
  the purity gate. Nothing reads `~/Library/PICO` — `resolveToolsRoot()` returns
  `DEFAULT_TOOLS_ROOT` without stat-ing it — and no fixture "binary" is executed (files are
  written with mode `0o755` and never spawned). The tmpdir is removed via `t.after`.
- **Discipline / YAGNI** — no persistent pin format, no subprocesses, no provisioning, no registry
  access, no caching layer. `executableNames` returns a list because the brief specifies probing
  candidates in order, even though every platform currently yields one name.
- **Quality** — `src/toolchainselection.ts` has no host imports at all, which is what makes the
  purity gate a real assertion rather than a comment. Platform-correct path handling comes from
  selecting `path.win32` vs `path.posix` off `io.platform`, so Windows fixtures exercise real
  Windows path semantics on a macOS host.

## Issues and concerns
1. **Fixture-only cross-platform evidence.** The Windows and Linux behaviour is proven against a
   simulated tree on a macOS host. This does not establish real Windows/Linux filesystem, casing
   or permission behaviour, and should not be reported as cross-platform compatibility.
2. **`test/toolchain-resolution.mjs` runs in no workflow yet** (see registration note above). Until
   the release track adds it, this suite can regress invisibly — the same trap AGENTS.md records
   for `test:runrevision`.
3. **Adapter semantics that could not be preserved exactly.** `resolveToolsRoot` swallows
   `ambiguous/property-conflict` (callout 4 above). Everything else preserves legacy behaviour,
   including returning `DEFAULT_TOOLS_ROOT` on platforms where the resolver refuses to invent a
   default.
4. **`resolveToolchain` reads whole payloads into memory** via `ToolchainIO.read` to hash them. For
   a large `spatialbundle` that is a full-file read per call. The legacy adapters avoid it
   entirely, so no hot path regressed, but S2 consumers should resolve once and reuse the result
   rather than calling `resolveToolchain` per operation.
5. **Not verified against the real SDK.** Per the dispatch, I did not touch
   `~/Library/PICO/sdk`, the emulator, or any MCP tool. The component subdirectory layout encoded
   here matches what `src/toolchain.ts` already used (`editor/spatialbundle/spatialbundle`,
   `emulator/emulator`, `emulator/system-images/platform-tools/adb`,
   `emulator/lib/emulator_controller.proto`); it is not independently re-confirmed against the
   0.13 / 6.0 / 6.1 installs on this host. The recommended verification is a read-only
   `resolveToolchain({required:["packer","emulator","adb","proto"]})` against the real root once
   S2 wires a consumer.
6. **No visual or device evidence** is claimed or applicable — this is host-only, fixture-backed
   unit work.

---

# Fix round 1

Commit: `07e1246` — `fix: validate requested toolchain components and host IO entry`
(on top of `bde4098`, branch `track/cli050-sdk`, not pushed). Both review findings addressed;
Minor items deliberately untouched this round.

## Finding 1 — `required` was never validated

### What was wrong
`missingComponents(install, [])` is vacuously satisfied, so `required: []` — a type-valid call,
since `readonly ToolComponent[]` permits it — selected any newest version directory, hashed
nothing, and digested the empty string. Demonstrated against the pre-fix build:

```
$ node scratchpad/collision.mjs      # two entirely unrelated fixture trees
tree A -> ok 6.1 /a/Library/PICO/sdk e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
tree B -> ok 9.9 /b/Library/PICO/sdk e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```
Identical `identity` for different roots, different versions, different bytes — the collision the
field exists to prevent, on the value S2 will key caching and verification on.

Separately, an out-of-union component string threw instead of returning a result:
```
TypeError: Cannot read properties of undefined (reading 'dir')   # COMPONENT_LAYOUT[component]
```

### Fix
- `src/toolchainselection.ts`: `selectInstallation` now validates caller input *before* anything is
  probed — unknown components first (`unavailable/component-unknown`, detail naming the offending
  values and the legal set), then an empty/absent set (`unavailable/required-empty`). Added
  `isToolComponent()` as the runtime guard (tool inputs arrive as JSON, not as TypeScript), and
  defensive `undefined` guards in `componentFile` / `expectedComponentLocation` because
  `scanInstallations` is exported and could be called directly by S2.
- Contract-table comment gained the rows `unavailable/required-empty`,
  `unavailable/component-unknown` and `unavailable/io-unavailable`, with a note explaining why an
  empty request must not be answerable.

Post-fix, the same probe returns `unavailable` for both trees.

## Finding 2 — untested, import-order-dependent global on the primary public API

### Fix (both halves, per controller guidance)
- `src/toolchain.ts` exports **`resolveHostToolchain(request)`**, which calls
  `resolveToolchain(request, hostToolchainIO())` explicitly. This is the entry point S2 consumes;
  it cannot be in an unregistered state.
- The registration singleton is kept for signature compatibility, but the unregistered case is no
  longer a throw: `resolveToolchain(request, io?)` returns structured
  `unavailable/io-unavailable` whose detail points at `resolveHostToolchain`. The signature stays
  `(request, io?)`; the default-parameter form was replaced with an explicit
  `io ?? defaultIOFactory?.() ?? null` so the failure is a value, not an exception.

## Tests added (44 total, was 40)
- `every contract failure code is reachable with its documented trigger` — rewritten as a table
  asserting **both `.status` and `.code`** for all eight rows, including the two new ones.
- `an empty required set is rejected, never answered with a constant identity` — asserts
  `unavailable/required-empty` for `[]` and for an absent field, across two different trees, plus
  that a successful selection's identity is never the empty-string digest (the constant is written
  out in the test so the regression is named, not implied).
- `an out-of-union component is a structured result, not a TypeError` — six bogus `required`
  payloads (`["editor"]`, `["packer","spatialbundle"]`, `[""]`, `[null]`, `[42]`, `["PACKER"]`)
  each wrapped in `assert.doesNotThrow`, plus detail-content assertions and a check that genuine
  duplicates are deduplicated rather than rejected.
- `resolveToolchain with no io and no registered host implementation is structured, not a throw` —
  imports `../dist/toolchainselection.js?unregistered`, a distinct module URL and therefore a fresh
  instance whose registration hook is unset: exactly the state an S2 consumer importing only that
  module sees. In-process and hermetic — no subprocess.
- `host entry points resolve against a real tree, symlink alias included` — builds an
  `os.tmpdir()` tree with `6.1.0/editor/spatialbundle/spatialbundle` and a real `6.1 -> 6.1.0`
  directory symlink, points `PICO_HOME` at it (saved/restored in `finally`, removed via `t.after`),
  then asserts: `resolveHostToolchain` resolves with `rootSource: "PICO_HOME"` and the real sha256
  of the payload; the bare `resolveToolchain({required:["packer"]})` agrees on identity and path
  (proving the registration side effect); `resolveHostToolchain` surfaces failures too
  (`required-empty`, `version-missing`); and **`hostToolchainIO().realpath` canonicalises the real
  symlink** to `fs.realpathSync(packer)` while returning `null` for a missing path. Symlink
  creation is wrapped in try/catch with a `t.diagnostic` fallback so an unprivileged Windows host
  degrades instead of failing.

## RED/GREEN evidence for this round
The new tests were run against the pre-fix source (`git checkout HEAD -- src/toolchainselection.ts
src/toolchain.ts`, rebuild) to prove they are real gates:

```
$ npm run build && node --test test/toolchain-resolution.mjs
ℹ tests 44
ℹ pass 39
ℹ fail 5

✖ every contract failure code is reachable with its documented trigger
  AssertionError: required names no components    actual: 'ok'  expected: 'unavailable'
✖ an empty required set is rejected, never answered with a constant identity
  AssertionError: actual: 'ok'  expected: 'unavailable'
✖ an out-of-union component is a structured result, not a TypeError
  AssertionError: Got unwanted exception: required: ["editor"]
    actual: TypeError: Cannot read properties of undefined (reading 'dir')
✖ resolveToolchain with no io and no registered host implementation is structured, not a throw
  AssertionError: Got unwanted exception.
    actual: Error: resolveToolchain needs a ToolchainIO: pass one, or import ./toolchain.js ...
✖ host entry points resolve against a real tree, symlink alias included
  TypeError: resolveHostToolchain is not a function
```
The fixed sources were then restored and rebuilt:
```
$ npm run build                                    # tsc, strict, clean
$ node --test test/toolchain-resolution.mjs
ℹ tests 44
ℹ pass 44
ℹ fail 0
$ node test/preflight.mjs
Preflight test done. Failures: 0
$ node test/projectgen.mjs
Projectgen test done. Failures: 0
```

## Files changed this round
```
 src/toolchain.ts              |  13 ++++
 src/toolchainselection.ts     |  70 ++++++++++-----
 test/toolchain-resolution.mjs | 169 ++++++++++++++++++++++++++++++-------
 3 files changed, 203 insertions(+), 49 deletions(-)
```
No new files; `test/toolchain-resolution.mjs` is still the only suite needing CI registration.

## Notes / residual concerns
- `unavailable/io-unavailable` is a third code beyond the brief's table. It is documented in the
  contract comment but, unlike the other codes, it describes a *wiring* fault rather than a
  toolchain state — S2 should treat it as a programming error surfaced as data.
- The singleton is kept only for the `resolveToolchain(request)` convenience form.
  `resolveHostToolchain()` is the recommended consumer entry and the one the report for S2 should
  point at; if S2 never needs the bare form, the singleton can be deleted outright.
- The symlink assertion is the one test whose coverage is host-conditional (it degrades with a
  `t.diagnostic` where symlinks cannot be created). On the `gates` job (ubuntu) it always runs; the
  `picocli-windows` job does not run this suite.
- Review Minor items were not addressed this round, per instruction.
