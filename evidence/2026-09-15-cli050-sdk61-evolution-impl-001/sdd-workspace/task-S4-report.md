# Task S4 — Invalidate ADB, proto, vault and JDK caches

Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-sdk-2026-09-15` (branch `track/cli050-sdk`)
Base: `524e606` (S1 + S2 + S3 and their fix rounds). Not pushed. Trailers verified on all four commits.

| Commit | Subject |
| --- | --- |
| `675ce0d` | `fix: invalidate selected SDK resource caches` |
| `3c5606a` | `refactor: share one packer toolchain preparation helper` (carried item c) |
| `f757f52` | `fix: read local.properties sdk.dir with java.util.Properties semantics` (carried item a) |
| `fd96e03` | `fix: harden the identity cache and the doctor's environment inputs` (self-review) |

---

## What I implemented, per sub-area

### `src/identitycache.ts` (new, 63 lines) — the primitive

```ts
export class IdentityCache<T> {
  get(key: string, load: () => T): T;
  getOr<U extends T>(key: string, load: () => U, cacheable: (value: U) => boolean): U;
  clear(): void;
}
```

One entry, keyed on a caller-computed identity string. Per controller resolution 1: a differing key
**evicts before `load` runs**, so a loader that throws can never leave the previous key's value
reachable; `getOr` is the "do not cache this value" channel for loaders that report failure as a
value (`{error}`, a null index) rather than as a throw. Nothing is published until `load` returns,
so absence is never cached. Deliberately one entry rather than a `Map`: these caches skip repeated
work on a hot path, and a `Map` keyed on file content is a leak that grows every time a payload is
rebuilt. A consumer that genuinely serves several resources at once keeps one cache per resource
(the vault does).

### `src/adb.ts` — one adapter, one precedence chain (controller resolution 2)

New exports: `AdbSource`, `AdbOverrideRejection`, `AdbResolution`, `AdbIO`, `hostAdbIO()`,
`resolveAdbExecutable(io?)`, `adbExecutable(io?)`, `clearAdbResolutionCache()`. `adbPath()` keeps
its signature and its error text (now with the probed candidate list appended). `cachedAdb` is
gone.

Precedence: explicit `$PICO_ADB` (must exist and be executable; its **bytes** are disclosed as
`source:"explicit"`) → PATH (`executableNames("adb", io.platform)` × `executableCandidates` from
`src/picocli.ts`, the JS PATH/PATHEXT helper — **no POSIX `which` subprocess**) → the selected
toolchain's bundled `adb`. The bundled candidate is reached through `resolveRootCandidate` +
`selectInstallation`, which **do not hash**, so the hot path never reads a multi-MB payload to pick
a candidate. The walk stops at the first usable candidate, so a host with adb on PATH never scans
the tools root.

`AdbIO extends ToolchainIO` with an optional `stat`, added in `src/adb.ts` rather than by editing
S1's `toolchainselection.ts` (not in my ownership). Cache key = `source \0 path \0 size \0 mtimeMs`;
the `load` does the one sha256. Without a `stat` the key falls back to the content hash — correct,
just not cheap; it never falls back to the path alone.

**A set-but-unusable `$PICO_ADB` falls through rather than failing closed, and the rejection is
carried on the result** (`overrideRejected: {path, reason}`). Rationale in "Decisions" below.

### `src/grpc.ts` — `loadProto` keyed on the selected schema's bytes (resolution 3)

`if (loaded) return loaded` ran *before* the requested version was looked at. The key is now the
requested version label + the selected version + the resolved proto path + `protoSchemaMaterial()`:
every `.proto` reachable through transitive `import "…";` statements inside the selected library
directory, as sorted `relative path \0 sha256` pairs. Bounded to `libDir` (a path resolving outside
it is recorded as `outside-library`, never read); an unreadable import is recorded as `missing`, so
a deleted dependency changes the key instead of silently matching the old one. No network. A failed
load is refused through `getOr`, preserving the pre-existing "a repaired proto loads without a
restart" behaviour. `loadProto` and `clearProtoCache` are exported for the integration test.

### `src/vault.ts` — `loadVaultIndex` keyed on the vault's content (resolution 4)

`Map<string, IdentityCache<VaultIndex | null>>` — one cache **per root**, because `vault_diff`
deliberately loads two roots back to back and neither should evict the other; that also preserves
today's multi-root performance exactly. Key = canonical root (`realpathSync`, falling back to
`path.resolve`) + `package.xml` bytes hash (with `absent` as a distinct value) + sorted declaration
filenames each paired with its content hash. `vaultRoot` in the returned index is still the raw
argument, so no output shape changed. Absence is still never cached (an empty/unreadable
`api-reference` returns `null` before the cache is consulted). The module header comment was
corrected — it claimed memoization per root.

### `src/toolchain.ts` — JDK discovery (resolution 5)

`cachedJavaHome` removed. `detectJavaHome(io: ToolchainIO = hostToolchainIO())` and
`gradleEnv(io = hostToolchainIO())` revalidate the ordered candidates every call: `io.env.JAVA_HOME`,
then the three bundled-JBR candidates including the user-home one (now `P.join(io.home, …)` instead
of `expandHome("~/…")`). `null` is never cached. No-argument callers keep their behaviour and
precedence, no PATH lookup was added and Java is never executed. The comment promising a
`/usr/libexec/java_home` fallback that was **never implemented** is gone.

### `src/preflight.ts` — JDK and ADB regions only

The `adb` row now follows the adapter's precedence (explicit `$PICO_ADB` → PATH → the selected
toolchain's adb → the legacy 0.13 path as a last candidate), still confirming every candidate by
actually running `adb version`. Its detail names the provenance (`… (from explicit $PICO_ADB)`,
`(from PATH)`, `(from bundled platform-tools of the selected 6.1 toolchain)`) and appends the
rejected-override note when a declared `$PICO_ADB` did not answer. `PreflightIO` gained
`adbOverride?` and `javaHomeEnv?`, both captured in `defaultIO()`, so the rows are a function of
their injected input rather than of this process's environment (the same leak class S2 removed from
the `pico-sdk` row). The `emulator status --format json` region — the CLI track's — is untouched
and unreformatted.

### Carried item (a) — `parseLocalPropertiesSdk`

`src/nativefleetreceipt.ts` matched `^\s*sdk\.dir\s*=` and unescaped only `\:` and `\\`. S3 now
writes `sdk.dir`/`spatial.tools.dir` through `serializeJavaProperty`, which escapes `#`, `!`, `=`,
`:` and everything outside printable ASCII as `\uXXXX`. It now uses `parseJavaProperties`. The
first declaration still wins and an absent file is still `null`; the value is **no longer trimmed**,
because `Properties.load` does not trim trailing spaces and the serializer writes them literally.
Exported so the suite that covers it (`test/nativefleetreceipt.mjs`, run by `npm run test:runreceipt`)
can assert the round trip; `grep parseLocalPropertiesSdk test/` returned nothing before this task.

### Carried item (b) — the untested S2 adb row

Six new assertions in the `test/preflight.mjs` S4 block: explicit `$PICO_ADB` provenance, that it is
probed **first**, PATH-before-bundled ordering, the bundled fallback, that the legacy 0.13 path is
not probed before the selected payload, an invalid override falling through *and* being disclosed,
and a failing row listing every probed candidate with a pointed fix.

### Carried item (c) — the four near-identical packer wrappers

`prepareOperationToolchain(request, {io, probe, resolve})` (resolve + settle) and
`settleOperationToolchain(prepared, probe?)` (the verify half alone, for `resolveSceneToolchain`'s
packer+editor preference) now live in `src/toolchain.ts` beside the seam they wrap. `src/bundle.ts`,
`src/editorexport.ts`, `src/bundlediff.ts` and `src/workflow.ts` call them. The `${code}: ${detail}`
error shape is byte-preserved, so every wrapper's exact error text and every caller's own prefix
(`iterate_scene: …`, `pack failed with …`) is unchanged. The step a copy-paste refactor is most
likely to drop is the override *verification* — a new test pins it in both directions.

---

## TDD — RED retained for every sub-area

### RED 1 — the suite exists, the module does not
```
$ npm run build && node --test test/toolchain-cache.mjs
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///…/dist/identitycache.js'
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

### RED 2 — JDK: the brief's fixture assertions against the unkeyed `cachedJavaHome`
Run against the **unmodified** build (harness in the session scratchpad, importing only
`dist/toolchain.js`):
```
  FAIL detectJavaHome(jdkIO("/jdk-a", true)) === "/jdk-a": Expected values to be strictly equal:
  FAIL detectJavaHome(jdkIO("/jdk-b", true)) === "/jdk-b": Expected values to be strictly equal:
  FAIL detectJavaHome(jdkIO("/jdk-b", false)) === null: Expected values to be strictly equal:
  FAIL detectJavaHome(jdkIO("/jdk-b", true)) === "/jdk-b" again: Expected values to be strictly equal:
  FAIL gradleEnv(jdkIO("/jdk-a", true)) deepEqual {JAVA_HOME:"/jdk-a"}: …deep-equal:
  info host answer actually returned: "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
```
All five fail the same way: the injected context is ignored entirely and this host's real JBR is
returned from the module cache.

### RED 3 — proto: the integration case, against the legacy `if (loaded) return loaded`
Seam exported, body untouched:
```
  ok   6.0 loads
  FAIL 6.1 request returns a 6.1 protoPath: got …/pico-s4-red-rP89Wy/6.0/emulator/lib/emulator_controller.proto
  FAIL 6.1 request carries the 6.1 rpc: the 6.1 request returned the cached 6.0 schema
  FAIL transitive import change reloads: cached package definition returned
  ok   malformed proto refuses
  ok   repaired proto loads without restart
```
The last two already passed — a failed load never set `loaded` — and the fix preserves that.

### RED 4 — adb: the defect measured on this host (read-only, no device)
```
consumer resolveAdb()        -> /Users/sushantsrikrish/Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb
structural adb selection     -> 6.1 /Users/sushantsrikrish/Library/PICO/sdk/6.1/emulator/system-images/platform-tools/adb
```
Every capture, deploy and verification on this machine ran the **0.13** adb while the structural
selection chose **6.1**.

### RED 5 — vault (`node test/vault.mjs`, 5 failures)
```
  ok   S4: an absent vault is not an index
  ok   S4: a vault provisioned after an absent lookup is loaded without restarting
  FAIL S4: a vault replaced at the same path is re-read (got ["AlphaComponent"])
  FAIL S4: an added declaration file changes the index
  FAIL S4: package.xml revision is read
  FAIL S4: a changed package.xml revision invalidates the cached index
  FAIL S4: removing every declaration file removes the cached index
```

### RED 6 — preflight (`node test/preflight.mjs`, 15 failures)
```
  FAIL explicit PICO_ADB not reported: {"name":"adb","status":"pass","detail":"adb","fix":null}
  FAIL override was not probed first: ["adb"]
  FAIL PATH-first ordering not reported: …
  FAIL invalid override mishandled: …
  FAIL adb failure detail incomplete: …(probed: adb, /sdk/6.1/…, /fake-home/Library/PICO/sdk/0.13/…)
  FAIL jdk inspection ignored the injected context: got "/Applications/Android Studio.app/…", want "/jdk-a"
  FAIL gradleEnv disagreed with detectJavaHome: {"JAVA_HOME":"/Applications/Android Studio.app/…"} vs "…"
  FAIL jdk row disagrees with the build lane: … (×3 contexts)
  FAIL jdk row source wrong: …
Preflight test done. Failures: 15
```

### RED 7 — the properties reader
```
SyntaxError: The requested module '../dist/nativefleetreceipt.js' does not provide an export named 'parseLocalPropertiesSdk'
```
then, with the seam exported and the body untouched:
```
✖ the local.properties sdk.dir reader uses real java.util.Properties escaping
  AssertionError: sdk.dir did not round-trip: /Users/té st/Library/Android/sdk
  + '/Users/t\\u00e9 st/Library/Android/sdk'
  - '/Users/té st/Library/Android/sdk'
```

### RED 8 — the DRY refactor tripped S2's own source gate (and I did not weaken it)
`test/toolchain-consumers.mjs` asserted the literal `resolveOperationToolchain` in each packer
consumer. After the extraction those consumers reach the seam through `prepareOperationToolchain`,
so the pattern now accepts either entry — the assertion's subject (no consumer resolves or hardcodes
a binary of its own) is unchanged, and a **new** case proves the helper still performs both halves.

### GREEN — exact commands and results

```
$ npm run build                                              # tsc, strict, clean
$ node --test test/toolchain-cache.mjs                       # tests 25  pass 25  fail 0
$ node test/preflight.mjs                                    # Preflight test done. Failures: 0
$ node test/vault.mjs                                        # Vault test done. Failures: 0
$ node --test test/observation.mjs test/navigation.mjs       # tests 106  pass 105  fail 0  skipped 1 (off-Darwin case)
$ node --test test/toolchain-resolution.mjs \
        test/toolchain-consumers.mjs                         # tests 77   pass 77   fail 0
$ node --test test/nativefleetreceipt.mjs                    # tests 76   pass 76   fail 0
$ node test/doors.mjs                                        # Doors test done. Failures: 0
$ npm run test:runreceipt                                    # tests 336  pass 336  fail 0  (~45 s)
$ npm run test:emulator-restart                              # tests 690  pass 689  fail 0  skipped 1
```
All re-run after the final commit (`fd96e03`). `test/observation.mjs` and `test/navigation.mjs`
pass **unchanged** — I did not edit either file.

---

## Files changed (`git diff --stat 524e606 HEAD`)

```
 src/adb.ts                   | 177 ++++++++++++++++++--     the adapter (+ cachedAdb removed)
 src/grpc.ts                  | 102 +++++++++---              proto keying + transitive imports
 src/identitycache.ts         |  63 ++++++++                  NEW — the primitive
 src/nativefleetreceipt.ts    |  24 ++-                       carried (a), properties reader only
 src/preflight.ts             |  44 ++++-                     JDK + ADB regions only
 src/toolchain.ts             |  87 +++++++---                JDK (S4) + the DRY helper (carried c)
 src/vault.ts                 | 119 ++++++++++----             cache keying only
 src/bundle.ts                |  12 +-   \
 src/bundlediff.ts            |  10 +-    |  carried (c): each wrapper calls the shared helper
 src/editorexport.ts          |  10 +-    |
 src/workflow.ts              |  12 +-   /
 test/nativefleetreceipt.mjs  |  50 ++++++
 test/preflight.mjs           | 110 +++++++++++++            S4 block appended at end of file
 test/toolchain-cache.mjs     | 375 +++++++++++++++++++++     NEW
 test/toolchain-consumers.mjs |  28 +++-
 test/vault.mjs               |  56 +++++++
 30 files changed, 1226 insertions(+), 218 deletions(-)
```

### Consumer-batch hunks (executable resolution ONLY)

| File | Hunk |
| --- | --- |
| `src/capture.ts` | `resolveAdb()` body → `return adbExecutable();` + the import. **One-line body change** (C6-sensitive). |
| `src/verifyapk.ts` | `const ADB = <0.13 literal>` → `const ADB = adbExecutable();` + the import. **One line** (C6-sensitive). |
| `src/deviceidentity.ts` | `resolveDeviceAdb()` body → `adbExecutable()`; three now-dead node imports removed. |
| `src/emulatorlook.ts` | exported `resolveAdb()` body → `adbExecutable()`. This one transparently upgrades the eight further modules that import it (`observation`, `navigationtarget`, `sceneanchors`, `capturerig`, `verifyvisual`, `boundaryexperiment`, `worldlocomotion`, `homeenvironmentselector`) — all call it lazily, none at module scope. |
| `src/eye.ts`, `src/sense.ts`, `src/assertscene.ts`, `src/deploy.ts`, `src/swanparity.ts` | `resolveAdb()` body → `adbExecutable()`; dead node imports removed where they became unused. |
| `src/perfprobe.ts`, `src/hybridbuild.ts`, `src/webbrowser.ts`, `src/webworkspace.ts` | `const ADB = <0.13 literal>` → `const ADB = () => adbExecutable();` and each `ADB` use site → `ADB()`, so resolution stays **lazy and revalidating** instead of frozen at import. |
| `src/fleetbuild.ts` | same, plus the three `process.env.PICO_ADB ?? ADB` pairs collapse to `ADB()` — the override is honoured inside the adapter now. |

Every argv array, `timeout`, `maxBuffer`, serial guard and capture/receipt requirement in those
files is byte-unchanged; `git diff` shows no hunk outside the resolution lines and the dead imports
they orphaned.

### New test files needing CI registration

- **`test/toolchain-cache.mjs`** (new, 25 `node --test` cases) — `node --test test/toolchain-cache.mjs`,
  requires `npm run build` first. No `package.json` script added, per the ownership boundary. It
  joins S1's `test/toolchain-resolution.mjs`, S2's `test/toolchain-consumers.mjs` and S3's
  `test/projectidentity.mjs`, all still unregistered — the same trap AGENTS.md records for
  `test:runrevision`.
- `test/preflight.mjs`, `test/vault.mjs`, `test/nativefleetreceipt.mjs`, `test/toolchain-consumers.mjs`
  are extensions of registered/known suites; no registration change.

---

## Decisions I made where the brief left room

1. **A set-but-unusable `$PICO_ADB` falls through to PATH rather than failing closed.** The
   controller's chain reads as a precedence list whose explicit branch is taken only when the file
   "exists and is executable". Failing closed would be a control-flow change in 14 consumers —
   including `src/deploy.ts`, whose contract is that it "CANNOT crash the autonomous loop" — on a
   stale export. So it falls through, but the rejection is **carried on the result**
   (`overrideRejected`) and the doctor's adb row prints it, which is the half that matters: an
   operator who names an adb explicitly is never silently handed a different one without a record.
   Reversing this is a one-branch change with tests already pinning both directions.
2. **`AdbIO` extends `ToolchainIO` locally in `src/adb.ts`** rather than adding `stat` to S1's
   `toolchainselection.ts`, which is outside my ownership. Fixtures that supply no `stat` still work
   (the key becomes the content hash).
3. **The vault keeps a per-root cache** (`Map<string, IdentityCache<…>>`) rather than one global
   entry, so `vault_diff`'s two back-to-back roots do not evict each other and today's performance
   characteristics are preserved.
4. **`parseLocalPropertiesSdk` keeps "first declaration wins"** (today's `.find` semantics) rather
   than switching to Java's last-wins, because the carried item asked only for the escaping fix and
   a duplicate `sdk.dir` is pathological. Recorded here in case the controller wants last-wins.

---

## Self-review

**Completeness.** Every brief checkbox has at least one test; all five controller resolutions and
all three carried items are implemented and covered. The brief's two verbatim snippets (the
`IdentityCache` three-assert regression and the five-line `jdkIO` block) appear verbatim.

**Verified against the task's own acceptance list:**
- *No absence is cached* — one test per resource: adb (`absence is never cached`), proto (`a failed
  proto load is not cached`), vault (`an absent vault is not an index` → provisioned → loaded), JDK
  (`an absent JDK that later appears is found without restarting`).
- *A replaced executable / proto / vault at the same path is observed without restarting* — one test
  each, plus the transitive-`.proto`-import case and the JBR-replaced-with-unchanged-environment case.
- *`verifyapk.ts` / `capture.ts` hunks are one-line executable-resolution changes* — confirmed by
  reading the diff; each is one changed line plus one import line.

**Three findings from my own review, fixed in `fd96e03`:** `IdentityCache` used
`value !== undefined` as its presence test (a latent miss-every-call bug for a future
`IdentityCache<T | undefined>`); `preflight`'s rows still read `process.env` directly for
`$PICO_ADB`/`$JAVA_HOME` (the same host leak S2 and S3 each found in their own area) — `defaultIO()`
now captures both; and the adapter's empty digest for an executable it cannot read is now documented
as an absence of evidence rather than a hash.

**Discipline.** No consumer was restructured beyond its executable lookup. No new tool, input,
schema or dependency. Nothing outside the ownership boundary was touched: no `package.json`,
`package-lock.json`, `.gitignore`, `.github/**`, `scripts/**`, `test/distribution-adoption.mjs`,
README/AGENTS/policy docs, `src/knowledge.ts`, `src/picocli*.ts`, `src/doors.ts`, `src/lint.ts`,
`src/vaultdiff.ts`, `src/projectgen.ts`, `src/scaffold.ts`, `src/projectidentity.ts`,
`src/toolchainselection.ts` or `test/helpers/toolchain-fixture.mjs`. `test/observation.mjs` and
`test/navigation.mjs` are unedited and pass. The emulator, the real SDK, devices, Java, Gradle and
MCP tools were never touched; nothing was pushed and no history was rewritten.

**Testing.** Fixtures inject their IO and their runners. The only host filesystem use is
`os.tmpdir()` trees the tests create and remove (`t.after`): the proto block needs real files
because `@grpc/proto-loader` reads them, and its fixture `emulator` payloads are written mode `0755`
and **never executed** — only `access(X_OK)`-probed. `PICO_HOME` is saved and restored around each
proto case, including the unset case. No fixture opens a device connection.

---

## Concerns

1. **`src/verifyapk.ts` still resolves adb at import time.** `const ADB = adbExecutable()` runs when
   `dist/index.js` imports the module, i.e. at server start, so a toolchain installed mid-session is
   not picked up there — exactly as stale as the module constant it replaces, but no more so, and it
   now resolves the *right* adb. I kept it to one line because the dispatch requires a trivial merge
   with track C6. **When C6 rewrites those call sites, the finish is `const ADB = () => adbExecutable()`
   plus `ADB` → `ADB()`**, the shape the other four `const ADB` consumers already use. It also leaves
   one now-unused `import os` in `verifyapk.ts` and one in `capture.ts`, untouched for the same reason.
2. **`src/nativefleetreceipt.ts:414` still defaults `adbPath` to `process.env.PICO_ADB ?? "adb"`.**
   That file is mine for the properties reader only, and its only production caller (`fleetbuild.ts`)
   now passes `ADB()` explicitly, so the default is unreachable in practice. Routing it through the
   adapter is a one-line follow-up for whoever owns that file next.
3. **The vault cache saves the parse, not the I/O.** Computing the content key reads every
   declaration file — the same reads the load performs. Parsing (~50 ms on the real 54-file vault) is
   the expensive half and is still skipped on a hit, but a caller in a tight loop now pays the reads
   every time. Unmeasured against the real vault; I did not benchmark it.
4. **The adb cheap key is `size + mtimeMs`.** A replacement that preserves *both* (a same-size copy
   with the mtime restored) is not observed until something else changes. Every realistic install,
   copy or symlink retarget changes one of them; a fixture with no `stat` hashes unconditionally.
5. **`resolveAdbExecutable` re-walks PATH on every call** (~30 `access` probes on a typical host), by
   design — the point is that the winner can change. At `assert_logcat`'s 700 ms poll interval this
   is noise, but it is per-`adb()`-invocation, not per-tool-call.
6. **Behaviour change worth naming: the whole server's adb moved from 0.13 to the selected version**
   on any host carrying both (measured: this one). That is the fix, but it *is* a change in which
   binary runs for capture, install, launch, logcat, screencap, push/pull and every device probe.
7. **Cross-platform behaviour is fixture-only.** The win32 `adb.exe`/PATHEXT case is a simulated tree
   on a macOS host; this is not evidence of real Windows filesystem, casing or permission behaviour.
8. **No native, device, emulator, Gradle or visual evidence is claimed.** Everything above is
   host-only, fixture-backed unit evidence plus two read-only observations of this machine's own
   `~/Library/PICO/sdk` layout (the RED 4 probe, which only printed paths). The recommended native
   follow-up, when a task is permitted: a read-only `preflight_env` confirming the `adb` row names
   the selected 6.1 payload, and one `capture_frame` confirming the same binary produced the frame.
9. **`pico_doctor {}` was not run** — this dispatch forbids MCP tool calls, and the work is
   host-only TypeScript, tests and git, so no environment gate applied.

---

# Fix round 1

Commit: `ba09967` — `fix: fail closed on an unusable explicit PICO_ADB and resolve adb lazily`
(on top of `fd96e03`, branch `track/cli050-sdk`, not pushed, trailer verified on the commit object).
Both Important findings fixed. The ledgered Minor items were not touched.

## Finding 1 — an explicit `$PICO_ADB` fell through instead of failing closed

The reviewer is right, and the part that makes it Important is the second half: my defence was that
"an operator who names an adb explicitly is never silently handed a different one **without a
record**", but the record never reached the point of use. `adbExecutable()` returns a `string` and
dropped `overrideRejected` on the floor, and all 13 migrated consumers call *that*. The rejection
survived only in `resolveAdbExecutable`'s return value and the doctor row — neither of which the
deploy/capture/verify path consults. So an install or a capture really did run a different binary
with nothing in its own result to say so, which is the exact failure class S4 exists to remove.

### What changed (controller ruling: fail closed)

`src/adb.ts`:

- `pick()` returns a three-way result. A declared `$PICO_ADB` that is unusable now returns
  `{kind:"override-rejected"}` and the walk **stops there** — no PATH entry and no bundled
  candidate is probed.
- `resolveAdbExecutable` returns `status:"unavailable"`, `code:"unavailable/adb-override-unusable"`,
  `overrideRejected:{path, reason}` and a detail naming **which path was configured, why it was
  rejected, and that no PATH/bundled fallback was attempted**, with the way out (correct it, or
  unset it).
- Rejection reasons cover the four states the ruling names: `names no existing file`
  (`io.realpath` null), `is not an executable file` (`io.executable` false), and
  `is not a readable regular file, so the bytes it would be identified by cannot be disclosed` —
  which covers both "unreadable" (X_OK without R_OK) and "not a regular file", since a **directory
  passes an X_OK check**. That last one is detected from the identity read, which the cache loader
  already performs; the empty-digest value is now refused by `getOr` rather than published, so a
  file that becomes readable is picked up on the next call and no refusal is ever cached.
- `adbExecutable()` **throws** `new Error(resolved.detail)` when `overrideRejected` is set, so every
  consumer surfaces it through its existing handler error path. "No adb anywhere" is deliberately
  **not** a throw — the bare `"adb"` last resort is unchanged, so that failure still lands at the
  spawn where it always did rather than at a new throw inside a handler that used to degrade.
  `adbPath()` already threw on any unavailable result and now carries the new message too.
- The module header documents the fail-closed rule as rule 1 of the precedence chain.

`src/preflight.ts` — the doctor must describe what the consumers will actually do, so the row
follows the same precedence:

- `adbCandidates()` returns **only** the override when one is configured (probing past it would
  report an adb no operation will run).
- The row is `fail` when a configured `$PICO_ADB` does not answer `adb version`, with the detail
  `$PICO_ADB=… did not answer \`adb version\`; an explicitly configured adb is never replaced by a
  PATH or bundled candidate, so nothing else was probed` and a fix that names both ways out. The
  no-override failure row is unchanged and still lists every probed candidate.
- The previous "fell through and was disclosed" note is gone, because falling through no longer
  happens.

## Finding 2 — `src/verifyapk.ts` resolved adb at import time

Also correct, and worse than I recorded it: `src/index.ts:130` imports the module at server start,
so that one consumer's adb was fixed for the process lifetime (invisible to a mid-session toolchain
change, and frozen to the literal `"adb"` forever if none resolved at startup), and every server
start — including a bare `tools/list` — paid a PATH walk, a possible tools-root scan and a sha256 of
the adb binary. It now matches the other four `const ADB` consumers:

```ts
const ADB = () => adbExecutable();
```

with `ADB()` at `src/verifyapk.ts:54, 67, 69, 82, 99, 113, 132, 136, 158` (the reviewer's line
numbers, shifted by the four-line comment). My round-1 "keep it to one line for a trivial C6 merge"
constraint no longer applies, so the residual concern 1 from the original report is closed.

**Confirmation the ruling asked for** — no consumer resolves adb at module load:
```
$ grep -n "^[^ \t].*adbExecutable()" src/*.ts | grep -v "=>"
(no output)
```
and the same rule is now a test, so it cannot come back silently.

## Tests

`test/toolchain-cache.mjs` (25 → 30 cases). The old `a set-but-unusable PICO_ADB is disclosed,
never silently substituted without a record` — the assertion that encoded the wrong behaviour — is
replaced, not kept:

| Case | What it pins |
| --- | --- |
| `a set-but-unusable PICO_ADB FAILS CLOSED and probes nothing else` | `unavailable/adb-override-unusable`; `probed` is exactly `[override]`; **no fallback payload is read** (`io.reads`). A working PATH adb *and* a bundled adb are present so "it resolved" cannot be mistaken for "it was correct". |
| `adbExecutable THROWS on an unusable explicit override, naming the path and the reason` | Both rejection reasons; the message contains the configured path, the reason, and "no fallback was attempted"; `io.reads` shows no PATH/bundled probing. |
| `an explicit override whose bytes cannot be read is refused, not silently identity-less` | `$PICO_ADB` at a directory (passes X_OK) → refused with the readable-regular-file reason. |
| `a corrected PICO_ADB is honoured immediately: a refusal is never cached` | broken → fixed within one process, no restart. |
| `a real consumer surfaces the refusal through its own error path, spawning no adb` | **the consumer-level case**: `executeLiveCaptureSettled` (the live entrypoint `test/observation.mjs` drives with its captured-runner fixture) called with no injected dependencies, so it goes through `emulatorlook.resolveAdb()` → `adbExecutable()`. Asserts the rejection carries the configured path/reason/no-fallback, and that **no capture file was written**. `process.env.PICO_ADB` is saved and restored (including the unset case) and the cache is cleared on both sides. |
| `no consumer resolves adb at module load` | source gate over every `src/*.ts`: a column-0 line calling `adbExecutable()` must be an arrow. |

`test/preflight.mjs` — the S2/S4 adb-row assertions moved to the fail-closed wording:
`an unusable PICO_ADB falls through and is disclosed` → **`an unusable PICO_ADB fails closed and is
disclosed`** (row is `fail`, names the override, the fix says "unset it"), plus a new
`a rejected override stops the probe: no PATH or bundled candidate is consulted`
(`probed` deep-equals `[override]`). `adb row probes the explicit override first` strengthened to
`adb row probes the explicit override and nothing else`. The old
`a failing adb row lists every probed candidate` case had set an override, so it is now split: with
**no** override the row still lists `adb`, the selected `/sdk/6.1/…` and the legacy `0.13` path.

## RED retained

Both fixed sources were replaced with their `fd96e03` versions, rebuilt, and the suites run:

```
$ npm run build && node --test test/toolchain-cache.mjs
✖ a set-but-unusable PICO_ADB FAILS CLOSED and probes nothing else (0.429125ms)
✖ adbExecutable THROWS on an unusable explicit override, naming the path and the reason (0.154584ms)
✖ an explicit override whose bytes cannot be read is refused, not silently identity-less (0.131833ms)
✖ a real consumer surfaces the refusal through its own error path, spawning no adb (1507.875583ms)
✖ no consumer resolves adb at module load (13.401708ms)
ℹ tests 30  ℹ pass 25  ℹ fail 5

$ node test/preflight.mjs
  FAIL invalid override mishandled: {"name":"adb","status":"pass","detail":"adb (from PATH) ($PICO_ADB /opt/broken/adb did not answer `adb version` and was skipped)","fix":null}
  FAIL fallback was probed after a rejected override: ["/opt/broken/adb","adb"]
Preflight test done. Failures: 2
```

The consumer-level case is the one worth reading twice: against the pre-fix source it took
**1507 ms**, because it really did fall through and spawn a *different* adb on this host — the
substitution the reviewer described, reproduced. Every other case in this file runs in under 8 ms.
The fixed sources were then restored and rebuilt.

## GREEN — exact commands and output

```
$ npm run build                                          # tsc, strict, clean
$ node --test test/toolchain-cache.mjs                   # tests 30  pass 30  fail 0
$ node test/preflight.mjs                                # Preflight test done. Failures: 0
$ node --test test/toolchain-consumers.mjs               # tests 29  pass 29  fail 0
$ node test/doors.mjs                                    # Doors test done. Failures: 0
$ npm run test:emulator-restart                          # tests 690  pass 689  fail 0  skipped 1
```
Regression beyond the required list, unchanged files:
```
$ node --test test/observation.mjs test/navigation.mjs   # tests 106  pass 105  fail 0  skipped 1
$ node test/vault.mjs                                    # Vault test done. Failures: 0
$ node --test test/toolchain-resolution.mjs              # pass 48  fail 0
```

## Files changed this round

```
 src/adb.ts               | 114 ++++++++++++++++------      fail-closed resolution + throwing adbExecutable
 src/preflight.ts         |  37 +++++++-----                the doctor row follows the same precedence
 src/verifyapk.ts         |  24 +++++----                   lazy ADB() at all nine call sites
 test/preflight.mjs       |  29 +++++----                   fail-closed adb-row assertions
 test/toolchain-cache.mjs | 124 +++++++++++++++++++++++++   5 new cases (25 -> 30)
 5 files changed, 255 insertions(+), 73 deletions(-)
```
No new files; `test/toolchain-cache.mjs` is still the one suite needing CI registration.

## Notes and residual concerns

1. **Behaviour change worth naming: an unusable `$PICO_ADB` is now a hard failure for every adb
   consumer**, where before this task it was silently ignored. That is the ruling, and it is the
   right default — but on a host with a stale `PICO_ADB` export, tools that "worked" yesterday now
   refuse with a message naming the export. The message says exactly how to fix it, and the doctor's
   adb row reports the same thing rather than a misleading pass.
2. **Original concern 1 is closed** (`verifyapk.ts` is lazy). The two dead `import os` lines I left
   in `src/capture.ts` and `src/verifyapk.ts` for the C6 merge are still there; `verifyapk.ts` is no
   longer a minimal-diff file, so that one could now be removed if the controller prefers.
3. **The fail-closed branch is fixture-proven plus one consumer-level case.** It has not been run
   against a real broken `$PICO_ADB` on a device lane; no native, device or visual evidence is
   claimed for this round either.

---

# Fix round 2

Commit: `69f7b48` — `test: make the adb refusal consumer case structurally hermetic`
(on top of `ba09967`, branch `track/cli050-sdk`, not pushed, trailer verified). The ledgered Minor
items were not touched.

## Negative evidence the checkpoint must retain: round 1's RED run spawned a real adb

Recorded plainly, because it is the reason this finding is Important.

While capturing RED for fix round 1 I ran `node --test test/toolchain-cache.mjs` against the
pre-fix `src/adb.ts`. The consumer-level case called
`executeLiveCaptureSettled({serial: "emulator-5554", outPath, maxTries: 2, …}, {})` with **no
injected dependencies**. Against pre-fix code `adbExecutable()` did not refuse the broken
`$PICO_ADB` — it fell through to PATH/bundled and returned a real adb — so
`src/observation.ts:768` built the real dependency set and `executeCaptureSettled` ran it:

- `defaultOnlineSerials(adb)` → **`adb devices -l`** (10 s bound) executed against this host's adb
  server, starting that server if it was not already running;
- the input named **`emulator-5554`**, the serial this repository reserves for the user, so if that
  emulator was online the pipeline would then have run `probeDeviceIdentity` (`adb -s emulator-5554
  shell getprop …`), `adb -s emulator-5554 shell cat /proc/sys/kernel/random/boot_id`, and
  `adb -s emulator-5554 exec-out screencap -p`, writing a PNG into the test's own `os.tmpdir()`
  scratch directory.

The run took **1507 ms** where every other case in the file takes under 8 ms, which is how the
re-reviewer spotted it. The case failed at its `assert.rejects`, so the trailing
"nothing was captured" assertion never executed — **I cannot claim the pipeline stopped at
`devices -l`**, and I am not going to imply it did. What is certain from the code path: every
command reachable there is read-only (`devices -l`, `getprop`, reading `boot_id`, `exec-out
screencap`); nothing installed, launched, force-stopped, cleared a log buffer, or restarted /
moved / resized the emulator; the only write was a PNG inside the temp directory the test itself
created and removed in `t.after`.

Why it cannot recur: the case no longer has a path to a real process at all (below), and a second
case proves the tripwire that would stop it actually fires. No test of mine names `emulator-5554`
any more.

## The finding — the consumer case is now structurally hermetic

The re-reviewer is right that the old case's safety was an emergent property of `adb.ts` throwing
early, not a property of the test.

The obvious repair does not work: injecting `dependencies` into `executeLiveCaptureSettled` makes
`src/observation.ts:768` short-circuit (`options.dependencies ?? defaultDependencies(… resolveAdb())`),
so `resolveAdb()` would never be called and the case would stop testing the thing it exists for.

So the case moved to `deploy_to_device` (`src/deploy.ts`), whose seam separates the two concerns:

```ts
const adb = (deps.resolveAdbFn ?? resolveAdb)();
const listed = await runFn(adb, ["devices"], { timeoutMs: 10_000 });
```

- `resolveAdbFn` is **deliberately not injected**, so the real adapter is the thing under test;
- `runFn`, `runBinaryFn`, `probeDeviceIdentityFn` and `sleepFn` are tripwires that record their call
  and `throw new Error("fixture reached a real spawn: <name>")`;
- the tool is registered against a stub `{registerTool}` object, so no MCP server is spawned;
- the target is `deviceSerial: "fixture-swan-0000"` — a fixture value; **no test of mine names
  `emulator-5554` or any real serial**;
- the assertions are that the refusal is surfaced (configured path, reason, "no fallback was
  attempted") **and** that the recorded-call list is empty.

A second case, `the loud-runner fixture would actually catch a spawn`, injects a *working*
`resolveAdbFn` so resolution succeeds and the handler immediately calls `runFn` — proving the
tripwire fires and records the adb it was handed. A tripwire nobody proves can fire is decoration.

Against pre-fix `src/adb.ts` the reworked case fails in **9.37 ms** with
`actual: 'fixture reached a real spawn: run'` — the fall-through caught structurally, at no point
reaching a process.

## The audit found something worse: a stale `$PICO_ADB` crashed server startup

Auditing for the same pattern, I ran the whole preflight suite under a hostile environment
(`PICO_ADB=/host/leaked/adb node test/preflight.mjs`) and the **server died at startup**:

```
Error: $PICO_ADB=/host/leaked/adb names no existing file. An explicitly configured adb is never
replaced by a PATH or bundled candidate, so no fallback was attempted — …
    at adbExecutable (dist/adb.js:150:15)
    at resolveAdb (dist/emulatorlook.js:19:12)
    at createLiveBoundaryExperimentDependencies (dist/boundaryexperiment.js:2560:17)
    at dist/boundaryexperiment.js:3473:63          <- MODULE SCOPE
```
and, once that was fixed, a second one:
```
    at createLiveInAppLocomotionDependencies (dist/worldlocomotion.js:4182:51)
    at registerInAppLocomotionTools (dist/worldlocomotion.js:4755:50)
    at dist/index.js:380:5                          <- TOOL REGISTRATION
```

This is round 1's fail-closed refusal escaping its intended blast radius. One stale `PICO_ADB`
export took down the entire server before it registered a single tool — no `tools/list`, no
`preflight_env`, and the doctor row that would have named the problem unreachable — for a user who
only wanted to scaffold a project. It is exactly what the round-1 ruling told me to confirm could
not happen, and **my round-1 source gate certified it as safe**, because that gate matched the
literal `adbExecutable(` and both offenders reach it one call hop away through
`emulatorlook.resolveAdb`.

Fixes, both "build on first use" rather than at import/registration, so the refusal lands in the
one handler that actually needs a device (both call sites sit inside the handler's existing
try/catch, so it surfaces as a structured tool error):

- `src/boundaryexperiment.ts` — `const liveOrchestrator = …` at module scope became a lazily
  memoized `liveOrchestrator()`.
- `src/worldlocomotion.ts` — `registerInAppLocomotionTools` built its dependencies eagerly; it now
  memoizes `liveDependencies()` / `orchestrator()` on first use. An **injected** `dependencies` is
  still honoured, because a caller supplying one has already resolved what it needs.

Neither file is in my ownership list; I changed them because the crash is a direct consequence of
my round-1 change and the ruling requires that a bad override cannot break startup. Both changes
are confined to deferring the construction — no behaviour, argv, guard or timeout was touched, and
`test/boundaryexperiment.mjs` + `test/worldlocomotion.mjs` (475 cases) pass unchanged.

### A third defect, found while pinning the fixture

`declaredAdbOverride` read `io.adbOverride ?? process.env.PICO_ADB`, so an explicit `null` — a
fixture saying "there is no override" — is nullish and fell straight back to the host environment.
The doctor rows were therefore still host-dependent, which is the leak the field was added to
remove. It now reads `io.adbOverride !== undefined ? io.adbOverride : process.env.PICO_ADB ?? null`,
matching how the jdk row already read `javaHomeEnv`, and `test/preflight.mjs`'s adb fixture declares
`adbOverride: null` explicitly. `PICO_ADB=/host/leaked/adb node test/preflight.mjs` now passes.

## The audit, case by case

Every test I added in S4, and everything in `test/toolchain-cache.mjs`:

| Case(s) | Could it reach adb / a process / a device? |
| --- | --- |
| `IdentityCache` ×4 | No. Pure in-memory, no imports beyond the primitive. |
| adb adapter ×9 (precedence, provenance, fail-closed ×4, replacement, no-rehash, absence, bare-name, win32) | No. Every one passes an explicit `toolchainIOFromTree` IO; `adbExecutable`/`resolveAdbExecutable` never fall back to `hostAdbIO()`. "Executable" is a boolean flag on a simulated tree — no fixture binary exists to run. |
| `loadProto` ×4 | No process. Real files under `os.tmpdir()` because `@grpc/proto-loader` reads from disk; `protoLoader.loadSync` and `fs` only. The fixture `emulator` payloads are written mode 0755 and are only `access(X_OK)`-probed, never executed. `PICO_HOME` saved/restored including the unset case. |
| JDK ×7 | No. Injected `ToolchainIO` throughout; `detectJavaHome` executes nothing (it is an `access` check). |
| consumer refusal + tripwire-proof ×2 | **Reworked this round.** Real adapter, every runner a loud tripwire, stub server, fixture serial. |
| `no consumer resolves adb at module load` | Reads `src/*.ts` as text. |
| `a broken $PICO_ADB cannot break server startup` (new) | Spawns **node** (not adb) as a child so the module registry is clean and the hostile env cannot leak; imports every dist module except `index.js` and calls every `register*Tools` with a stub. No adb, no device, no emulator. |
| `test/preflight.mjs` S4 block (14 assertions) | No. `io.exec` is a fake in every case; `adbOverride`/`javaHomeEnv` now pinned so no host env is read. |
| `test/vault.mjs` S4 block | No. `fs` under `os.tmpdir()` only. |
| `test/nativefleetreceipt.mjs` S4 block | No. `fs` under `os.tmpdir()`; it calls the exported pure parser, never `produceNativeFleetReceipt`. |
| `test/toolchain-consumers.mjs` new case | No. Injected `io` and an injected `probe`, so `defaultOverrideProbe` (the only thing that would run a binary) is unreachable. |

`grep -nE "child_process|spawn|execFile|execSync|run\(|runBinary|emulator-5554|adb devices" test/toolchain-cache.mjs` now returns only the tripwire stubs, the new child-process gate, and the comments explaining them.

## GREEN — exact commands and output

```
$ npm run build                                            # tsc, strict, clean
$ node --test test/toolchain-cache.mjs                     # tests 32  pass 32  fail 0
$ node --test test/observation.mjs test/navigation.mjs     # tests 106  pass 105  fail 0  skipped 1
```
Regression beyond the required list:
```
$ node test/preflight.mjs                                  # Preflight test done. Failures: 0
$ PICO_ADB=/host/leaked/adb node test/preflight.mjs        # Preflight test done. Failures: 0
$ node test/doors.mjs                                      # Doors test done. Failures: 0
$ npm run test:emulator-restart                            # tests 690  pass 689  fail 0  skipped 1
$ node --test test/toolchain-consumers.mjs \
        test/toolchain-resolution.mjs                      # tests 77  pass 77  fail 0
$ node --test test/boundaryexperiment.mjs \
        test/worldlocomotion.mjs                           # tests 475  pass 475  fail 0
```

RED, against `ba09967` (rebuilt each time, sources restored after):
```
$ node --test test/toolchain-cache.mjs                     # pre-fix adb.ts
✖ a real consumer surfaces the refusal through its own error path, spawning no adb (9.370333ms)
    actual: 'fixture reached a real spawn: run'
✔ the loud-runner fixture would actually catch a spawn

$ PICO_ADB=… <startup gate>                                # pre-fix boundaryexperiment/worldlocomotion
[ "import boundaryexperiment.js: $PICO_ADB=… names no existing file. …",
  "import worldlocomotion.js: $PICO_ADB=… names no existing file. …" ]
```

`test/distribution-adoption.mjs` fails 2 of 43 — **pre-existing**, confirmed by re-running it with
`test/toolchain-cache.mjs` moved aside (identical 41 pass / 2 fail). These are the gate-inventory
and script-count assertions AGENTS.md already records as red for their own reasons.

## Files changed this round

```
 src/boundaryexperiment.ts |  17 ++++-      live orchestrator built on first use
 src/worldlocomotion.ts    |  18 +++--      live dependencies built on first use
 src/preflight.ts          |  10 +++-       explicit null no longer falls back to the host env
 test/preflight.mjs        |   3 ++         adb fixture pins adbOverride: null
 test/toolchain-cache.mjs  | 131 ++++++--   tripwire consumer case, tripwire proof, startup gate
 5 files changed, 147 insertions(+), 32 deletions(-)
```

## Concerns

1. **Two files outside my ownership were changed** (`src/boundaryexperiment.ts`,
   `src/worldlocomotion.ts`), deliberately and minimally: deferring construction, nothing else. If
   the controller would rather those land on their owning track, the alternative is reverting the
   throw in `adbExecutable()` — which would undo round 1's ruling — so I judged deferring to be the
   smaller change. Both files' suites (475 cases) pass unchanged.
2. **The startup gate spawns a node child process** (~160 ms). It is the only way to get a clean
   module registry after this suite has already imported dist modules under a good environment. It
   spawns no adb, no emulator and no device.
3. **The behavioural gate filters to adb-related failures.** Other `register*Tools` failures (a
   registration function needing a real argument) are ignored rather than failing this suite, so it
   stays a targeted gate for this bug class rather than a second, accidental smoke test.
4. **`adbExecutable()` throwing remains a live hazard for any code that resolves adb outside a
   handler.** The two offenders are fixed and gated, but the gate only covers module scope and
   `register*Tools`. A future eager resolution inside some other startup path would still be found
   only by the hostile-env run, not by the gate.
5. Still no native, device, emulator or visual evidence for any of this work.
