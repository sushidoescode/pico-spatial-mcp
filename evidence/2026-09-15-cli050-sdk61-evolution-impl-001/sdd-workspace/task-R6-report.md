# Task R6 — Publish only verified artifacts without deleting earlier versions

**Status:** DONE
**Worktree:** `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-release-2026-09-15` (branch `track/cli050-release`)
**Commit:** `ad3e1d6` — `fix: preserve prior verified release artifacts` (not pushed)
**Base:** `ff5fa8d` (Tasks R1–R5 complete and reviewed)

---

## The defect

`scripts/verify-tarball.mjs:407–412` (at base):

```js
fs.mkdirSync(dest, { recursive: true });
for (const old of fs.readdirSync(dest).filter((f) => f.endsWith(".tgz"))) fs.rmSync(path.join(dest, old));
const out = path.join(dest, path.basename(verifiedTarball));
fs.copyFileSync(verifiedTarball, out);
```

Publishing 37.0.0 into a directory holding 36.9.x **deleted** the archives testers were still
installing from, and it deleted them *before* the copy — so a copy that failed after the sweep left
the directory with no release at all. `copyFileSync` would also have silently overwritten a
same-named artifact.

---

## What I implemented

### `scripts/publish-tarball.mjs` (new, 287 lines) — a primitive that can only ADD

| Export | Behaviour |
| --- | --- |
| `publishVerifiedTarball({source, destination, expectedSha256, io?})` | `{path, sha256, bytes}`. Destination is an exact FILE path. |
| `writePublicationReceipt({destination, receipt, io?})` | `{path, bytes}`. Writes `<destination>.receipt.json` with `wx`; a collision throws. |
| `receiptPathFor(destination)` | `` `${destination}.receipt.json` `` |
| `fileDigest(filePath)` | `{sha256, bytes}`, streamed in 1 MiB chunks so a large tarball never lands in memory. |
| `PUBLISH_IO` | The default seam (`openExclusive`/`openRead`/`read`/`write`/`fsync`/`close`/`link`/`rename`/`unlink`). A caller may override one entry; the rest fall through. |

The sequence, in the order its guarantees are enforced:

1. **Digest first.** The source is hashed and compared to `expectedSha256` before anything is
   staged. Bytes that did not pass verification never reach the destination directory at all.
2. **Stage into a task-owned temporary** — `.<basename>.<16 hex>.part` in the destination's *own*
   directory, opened `wx` (retried up to 8 times on the impossible EEXIST). Nothing partial is ever
   visible under the destination name.
3. **Re-read and re-hash what landed**, deliberately through **real `fs`, never through `io`**, so a
   broken or injected write cannot certify itself. Byte count is compared too.
4. **Publish with `fs.linkSync`** — exclusive and non-replacing. `EEXIST` throws an error whose text
   contains `exists`; the existing artifact is not touched, opened, or read.
5. **`finally` removes only the temporary this call created**, tolerating `ENOENT` and reporting any
   other removal failure to stderr rather than masking the error that brought us there.

There is **no directory enumeration anywhere in the module**, so no other archive is reachable by
any code path. A structural test asserts that (`readdir`, `rmSync`, `rm(`, `rimraf`, `glob` are all
absent from the executable code) and that every `unlink` argument names a task-owned path.

**Hard-link fallback.** On a filesystem with no hard links (`EXDEV`, `EPERM`, `ENOSYS`,
`EOPNOTSUPP`, `ENOTSUP`, `EMLINK` — FAT/exFAT, some network mounts, some Windows shares) the name is
first claimed with an exclusive `openSync(destination, "wx")` probe; only if that succeeds is the
probe closed, unlinked, and the temporary `rename`d in. `rename` replaces silently, so it is never
reached without the exclusive claim in front of it. The window between removing the probe and the
rename is documented in-file as the narrowest non-replacing sequence the platform offers; the
hard-link path, which has no such window, is used everywhere links exist. Any link error code
outside that set is rethrown untouched — an unexpected failure is never downgraded into the rename
path.

**Receipt ordering** is documented in the module header: artifact first, receipt second. A receipt
collision then fails loudly with the verified artifact already in place, which destroys nothing;
reserving the receipt first would add a removal path for no gain.

### `scripts/verify-tarball.mjs` — every existing check kept, publication delegated

- **`--publish` now names the destination FILE.** `resolvePublishTarget` expands a leading `~` (only
  `~/` or bare `~`, so `~weird/x.tgz` is no longer mangled the way `replace(/^~/, homedir)` did),
  and refuses an existing directory or a non-`.tgz` basename with a message naming the expected form
  `<dir>/pico-spatial-mcp-<version>.tgz`. The refusal happens **before the sandbox is created**, so a
  bad flag costs a millisecond instead of a five-minute pack-and-install.
- **Per-check classification.** `ok`/`fail` now also record `{name, status}`, and a new `skip`
  records the one branch where checks genuinely do not run (`briefs/` content checks when the
  directory is absent — the `[M1]` payload check has already failed by then, so this is an
  explanation, not a new tolerance).
- **The artifact digest is taken once, at pack time**, before any check runs, and the publish call
  passes *that* digest. `publishVerifiedTarball` re-derives it independently, so a tarball that
  changed between verification and publication cannot be published. The packed line now prints it:
  `ok packed pico-spatial-mcp-37.0.0.tgz (1981 kB, sha256 f541cad6…)`.
- **New check `[M9]`:** the packed `dist/build-receipt.json` must be readable, so a payload with no
  build binding fails the gate instead of yielding a receipt with a hole in it.
- **Publication branch** calls the helper, then writes the receipt, with a `catch` that turns a
  refusal into a normal `FAIL` line and exit 1 rather than an unhandled top-level throw. The
  not-publishing branch now names both paths it left untouched.

### The publication receipt — `<destination>.receipt.json`

```
schemaVersion, artifact{path,name,sha256,bytes}, package{name,version},
build{schemaVersion,input{sha256,files},output{sha256,files},typescript,nodeMajor},
platform{os,arch,node}, command{argv}, checks[{name,status}], limitations[]
```

`package` and `build` are read out of the **installed (i.e. packed) copy**, never out of the
checkout, so the identity corresponds to R1's packaged output and not to a later working-tree state.
`checks` is a snapshot taken immediately before publication — the checks that *gated* it. No
timestamp: the brief does not list one and R1 deliberately kept time out of build receipts.

`limitations` is derived, not boilerplate: three static entries (platform scope, no host-plugin
discovery, no emulator/device/visual claim) plus a fourth pushed at runtime when the doors
self-client round-trip ran with the vault absent.

### `scripts/gate-inventory.mjs`

`test:tarball` gains a second argv array, `["node","--test","test/publish-tarball.mjs"]`, placed
**first** so the hermetic suite runs without a network and a broken publication primitive fails in
80 ms instead of after a full pack-and-install. No new gate name, so no published count moved.

### `TESTERS.md`

One new section, **"Where this `.tgz` came from"**, between Install and Register: the archive is the
artifact the checks ran against; publication only ever adds, under a version-stamped name, so an
earlier `.tgz` stays byte-identical; the sibling `…tgz.receipt.json` carries the digest, the build,
the platform, every check and a `limitations` list worth reading; `shasum -a 256` to compare. Plus
the maintainer line documenting the flag's meaning change. The byte-pinned policy block is
untouched — `git diff TESTERS.md` is 22 added lines and nothing else, and
`test:distribution-adoption`'s canonical-bytes assertion passes.

---

## TDD evidence

### RED — `test/publish-tarball.mjs` written first, implementation absent

```
$ node --test test/publish-tarball.mjs

Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'/Users/.../cli050-track-release-2026-09-15/scripts/publish-tarball.mjs'
imported from /Users/.../cli050-track-release-2026-09-15/test/publish-tarball.mjs
    at finalizeResolution (node:internal/modules/esm/resolve:271:11)
  code: 'ERR_MODULE_NOT_FOUND',

✖ test/publish-tarball.mjs (27.898208ms)
ℹ tests 1   ℹ pass 0   ℹ fail 1
```

### GREEN

```
$ node --test test/publish-tarball.mjs
✔ publishes a verified tarball alongside prior versions, leaving every one of them untouched
✔ refuses to replace an existing artifact, and the prior bytes and directory listing do not move
✔ refuses a source whose digest is not the digest that passed verification, and writes nothing
✔ an interrupted copy removes its own temporary and never creates the destination
✔ re-reads the staged bytes and refuses to publish a copy that does not hash to the verified digest
✔ falls back to an exclusive probe and a rename when the filesystem cannot hard-link
✔ the rename fallback still refuses an occupied destination instead of overwriting it
✔ creates a missing destination directory, and refuses malformed arguments before touching disk
✔ writes the receipt beside the artifact and never overwrites an existing one
✔ the publication module contains no directory enumeration and no recursive removal
✔ verify-tarball publishes through the helper and removes nothing but its own sandbox
ℹ tests 11   ℹ pass 11   ℹ fail 0
```

Hermetic: `fs.mkdtempSync` directories whose names carry a space and `é` (same [M6] rationale as
verify-tarball), real files, real hard links, real EEXIST, no npm, no network, no sleeps. The two
prior archives carry NUL and `0xFF` bytes — built with `Buffer.from([0x00, 0xff])` rather than
source escapes, so the fixture is genuinely hostile while the test file stays a reviewable text
diff. Output is pristine (no stray writes, no leaked temp directories).

The brief's three collision assertions appear verbatim:

```js
assert.throws(() => publishVerifiedTarball({ source, destination: existing, expectedSha256 }), /exists/);
assert.deepEqual(fs.readFileSync(existing), priorBytes);
assert.deepEqual(fs.readdirSync(archiveDir).sort(), priorNames);
```

### Mutation probes — proof the tests are not vacuous

Each mutation applied to a backed-up copy, run, then reverted; the module was restored
byte-identically (`sha256 c9080c0d6fe6…` before and after) and re-verified at 11/11.

| Mutation | Suite result |
| --- | --- |
| M1 `land()` uses `copyFileSync` instead of `link` | ✖ 3 tests (collision, both fallback tests) |
| M2 source digest check removed | ✖ refuses a source whose digest is not the digest that passed verification |
| M3 staged re-hash removed | ✖ re-reads the staged bytes and refuses to publish a corrupted copy |
| M4 temporary never removed in `finally` | ✖ 6 tests |
| M5 `openExclusive` opens `"w"` instead of `"wx"` | ✖ receipt collision, rename-fallback collision |
| M6 directory enumeration reintroduced into the module | ✖ structural test + the mkdir test |
| M7 **the original defect restored in verify-tarball** (`readdirSync` + `rmSync` + `copyFileSync` in the publish branch) | ✖ verify-tarball publishes through the helper and removes nothing but its own sandbox |

M7 is the important one: the regression guard pins the *actual* defect at its actual site, asserting
that the only `rmSync` argument anywhere in `verify-tarball.mjs` is `sandbox` and that
`copyFileSync` does not appear at all.

---

## Gate runs (all after `npm run build`)

| Command | Exit | Result |
| --- | --- | --- |
| `npm run build` | 0 | `build-source: published 182 file(s) for source 209366c3ebda` |
| `node --test test/publish-tarball.mjs` | 0 | 11 pass / 0 fail |
| `npm run test:tarball` | 0 | publish suite 11/11, then `Tarball verification done. Failures: 0` (44 checks) |
| `node --test test/gate-inventory.mjs` | 0 | 31 pass / 0 fail |
| `npm run test:lint` | 0 | `Lint fixture test done. Failures: 0`; 42 pass / 0 fail |
| `npm run test:distribution-adoption` | 0 | 43 pass / 0 fail |
| `npm run test:docsmeta` | 0 | `Docs/metadata gate done. Failures: 0` (incl. `sync-metadata --check: no stale version/tool-count literals`); 26 pass / 0 fail |

Re-run end-to-end after the final file change; every one exits 0. No pre-existing red remains in
these lanes (R1's five known failures were closed by R3/R4/R5).

**Flag-validation paths**, each exiting 1 before the sandbox is created:

```
$ node scripts/verify-tarball.mjs --publish /tmp
  FAIL --publish now names the destination FILE, not a directory: /tmp is a directory.
       Use <dir>/pico-spatial-mcp-<version>.tgz

$ node scripts/verify-tarball.mjs --publish /tmp/pico-release-dir
  FAIL --publish needs a .tgz destination file path, not /tmp/pico-release-dir.
       Use <dir>/pico-spatial-mcp-<version>.tgz

$ node scripts/verify-tarball.mjs --publish
  FAIL --publish needs a destination file path, e.g. --publish ~/releases/<date>/<name>-<version>.tgz
```

---

## The publish exercise — real archives, real decoys

Fresh directory, created for this task, outside the repository and outside `$HOME`'s document tree:

```
/private/tmp/claude-501/-Users-sushantsrikrish-PICO-MCP/4bdd1daf-.../scratchpad/2026-09-15-R6-publish-evidence
```

### Decoys seeded

```bash
printf 'DECOY PRIOR RELEASE 36.9.0 — sentinel bytes, must survive publication\n' > $EV/pico-spatial-mcp-36.9.0.tgz
printf 'DECOY PRIOR RELEASE 36.9.1 — sentinel bytes, must survive publication\n' > $EV/pico-spatial-mcp-36.9.1.tgz
```

| File | Bytes | sha256 **before** | sha256 **after** |
| --- | --- | --- | --- |
| `pico-spatial-mcp-36.9.0.tgz` | 72 | `c348358b3ec911c6cd6383053db1186f399fb6ddd807d324fd292695c52dc571` | `c348358b…dc571` *(identical)* |
| `pico-spatial-mcp-36.9.1.tgz` | 72 | `243f068424e1c9ddd38e1bbb195d475c6f84b782cee0d819a3e83c92b85c63bf` | `243f0684…c63bf` *(identical)* |

### Publication

```bash
$ node scripts/verify-tarball.mjs --publish "$EV/pico-spatial-mcp-37.0.0.tgz"
EXIT=0
  ok   packed dist/build-receipt.json binds the payload to source 209366c3ebda / output 7f6982fdc40b
  ok   published the VERIFIED tarball to $EV/pico-spatial-mcp-37.0.0.tgz
       (2028912 bytes, sha256 85b6140e880e541938142255f5cbea6ce5bfc0c8392016abd10fa708c3c243ff)
  ok   wrote the publication receipt to $EV/pico-spatial-mcp-37.0.0.tgz.receipt.json

Tarball verification done. Failures: 0
```

Directory afterwards: the two decoys (72 bytes each, hashes above, unchanged), the published
`pico-spatial-mcp-37.0.0.tgz` (2 028 912 bytes), and `pico-spatial-mcp-37.0.0.tgz.receipt.json`
(6 158 bytes). **Four entries, no temporary.**

Receipt contents: 44 checks, every one `pass`; `package` `pico-spatial-mcp@37.0.0`; `build.input`
`209366c3ebdac23d…` over 187 files and `build.output` `7f6982fdc40b3c44…` over 182 files, TypeScript
5.9.3; `platform` `darwin/arm64/v25.8.1`; `command.argv`
`["node","scripts/verify-tarball.mjs","--publish","<path>"]`; three `limitations` entries.

### The refusal, end to end

Re-running the identical command against the same destination:

```bash
$ node scripts/verify-tarball.mjs --publish "$EV/pico-spatial-mcp-37.0.0.tgz"
EXIT=1
  FAIL publication refused: refusing to publish: the artifact $EV/pico-spatial-mcp-37.0.0.tgz
       already exists. A published artifact is never replaced — publish under its own
       version-stamped name, or move that file aside deliberately first.

Tarball verification done. Failures: 1
```

All four files byte-identical afterwards (same hashes, same sizes, same mtimes), nothing added,
nothing removed. Under the base implementation this same second invocation would have deleted all
three `.tgz` files.

---

## Files changed

| File | Change |
| --- | --- |
| `scripts/publish-tarball.mjs` | **new**, 287 lines — the non-replacing publication primitive and the receipt writer |
| `test/publish-tarball.mjs` | **new**, 314 lines — 11 hermetic tests |
| `scripts/verify-tarball.mjs` | +143/−16 — check recording, `--publish` file semantics, pack-time digest, `[M9]` packed-build check, delegated publication + receipt |
| `scripts/gate-inventory.mjs` | +8/−1 — `test:tarball` gains the hermetic suite as its first command |
| `TESTERS.md` | +22 — one publication-guidance section, outside the policy block |

Untouched, as required: `src/**`, `scripts/build-*.mjs`, `scripts/plugin-bootstrap.mjs`,
`scripts/run-gate.mjs`, `scripts/run-battery.mjs`, `test/smoke*.mjs`, `test/docsmeta.mjs`,
`scripts/public-docs.mjs`, `package.json`, every policy block. No existing verify-tarball check was
removed or weakened: the clean install, hostile sandbox path, derived payload, brief canaries, leak
scan, reader-facing docs, app/Unity skeletons, exact 255/252 counts and 43 anchors, `preflight_env`
shape, doors self-client round-trip and env-unset default are all present and all passed in the
final run.

---

## Self-review

Checked against the brief's checkboxes and the controller's eight resolutions:

- **Resolution 1 — the publication sequence.** Digest-first, `wx` temporary in the destination
  directory, copy + `fsync` + re-hash, `linkSync`, `unlink` in `finally`, no `readdir`, explicit file
  destination, documented `EXDEV`/`EPERM` fallback behind an exclusive probe, never `copyFileSync`
  over an existing file. ✅
- **Resolution 2 — the receipt.** Sibling `<destination>.receipt.json`, `wx`, artifact
  path/sha256/bytes, packed package name/version, packed build input/output sha256s, platform,
  command line, per-check pass/skip, `limitations`. ✅
- **Resolution 3 — flag semantics.** Exact destination file; a directory is an error naming
  `<dir>/<name>-<version>.tgz`; flag name kept; meaning change documented in the script usage text
  and in TESTERS.md. ✅
- **Resolution 4 — the test set.** Two prior archives + fresh destination; collision (three verbatim
  assertions); digest mismatch; interrupted copy via the `io` seam (both `write` and `fsync`);
  receipt collision. Hermetic, no npm. ✅
- **Resolution 5 — the exercise.** Run and recorded above with hashes before and after. ✅
- **Resolution 6 — TDD.** RED retained verbatim. ✅

Things I looked for specifically, and what I found:

1. **Can any code path enumerate or delete another archive?** No. `publish-tarball.mjs` has no
   `readdir`/`rmSync`; every `unlink` names the temporary, the probe it just created with `wx`, or a
   receipt it just created. Both facts are asserted structurally and mutation-probed (M6). In
   `verify-tarball.mjs` the only `rmSync` argument is `sandbox` and `copyFileSync` no longer appears
   — asserted and probed (M7).
2. **Does a failed publication leave a partial destination?** No. The destination is only ever
   created by `link`/`rename`, both of which are atomic and both of which happen *after* the staged
   copy has been re-read and re-hashed. Injected `write` and `fsync` failures both leave the
   directory listing unchanged (tested); an injected corrupting write is caught by the re-read
   (tested, M3-probed).
3. **Can a receipt overwrite one?** No — `wx`, tested and M5-probed. A partial receipt (a write or
   fsync failure after the file is created) is removed, since we created it in that same call.
4. **Is the byte-pinned policy block intact?** Yes. `git diff TESTERS.md` shows 22 added lines in one
   new section and nothing else; `test:distribution-adoption` (which holds the canonical bytes inline
   and rejects the policy vocabulary outside the markers) passes. I kept `latest`, `fallback`,
   `managed-*`, `PICO_MCP_CLI_*`, `PATH`, `setup`, `update --check` and every
   external/disabled/ambient/global-plus-policy clause out of the new prose entirely, and used no
   `NN tools` phrasing that `sync-metadata` would rewrite.

Two things I changed during self-review rather than because a test failed:

1. **The digest was derived twice from the same file at publish time**, which made the helper's
   verification tautological in the only call path that exists. I moved it: the digest is now taken
   once immediately after `npm pack`, before any check runs, and the publish call passes that value —
   so the helper's independent re-derivation is a real check on a real window.
2. **`test/publish-tarball.mjs` committed as a binary blob.** The prior-archive sentinels used
   ` ` in a string literal, which reached disk as an actual NUL byte, so git classified the file
   `Bin 0 -> 14936 bytes` and the review diff would have been unreadable. Rebuilt the fixture with
   `Buffer.from([0x00, 0xff])` — the hostile bytes are still in the fixture, the source file is pure
   text, and the commit was amended (`e2f1265` → `ad3e1d6`). Also made the `--publish` usage example
   use `<date>` instead of a hardcoded one, and made the error-hint construction lazy so the success
   path does not read `package.json` for a string it never uses.

---

## Concerns

1. **`AGENTS.md:24` says "61 of the 85 `test/*.mjs` files".** It was already off by one at `ff5fa8d`
   (86 files, 61 dist-importers, measured with `git ls-tree --name-only HEAD test/`), and my new
   suite makes it 87. The "61" half is **unchanged** — `test/publish-tarball.mjs` imports
   `../scripts/publish-tarball.mjs`, never `../dist/`. `AGENTS.md` is outside this task's ownership
   and nothing gates the number, so I left it; whoever integrates the track should restate it as
   "61 of the 87".
2. **The rename fallback has a TOCTOU window** between unlinking the exclusive probe and the rename.
   It is documented in-file and is unreachable on every filesystem that supports hard links (i.e.
   every CI runner and every developer machine this project has run on). It exists so a FAT/exFAT or
   network destination still gets a non-replacing publication rather than a silent overwrite; the
   only strictly-safe alternative would be to refuse those filesystems outright.
3. **`npm pack` is not byte-reproducible** (gzip embeds mtimes), so the artifact sha256 differs
   between runs of the same source: `f541cad6…` in the final gate run, `85b6140e…` in the publish
   exercise. The `build.input`/`build.output` identities in the receipt *are* stable
   (`209366c3ebda…` / `7f6982fdc40b…`), which is exactly why the receipt carries both — the artifact
   digest identifies the file, the build identity identifies what is inside it.
4. **The cross-track canaries are deliberately absent**, per the dispatch: no SDK-payload `[M6]`
   verifier block and no doors 20-way burst / `pico_look isError` assertion. A later integration
   task wires those after the merge.
5. **`test:tarball` still needs npm registry access** for its clean install, so the gate as a whole
   is not offline-capable. The new hermetic suite is now the gate's *first* command, so at least the
   publication primitive is proven on an offline machine before the network-dependent half runs.
6. **Nothing here is a visual or device claim.** This is host-only filesystem and process evidence:
   real files, real hard links, real collisions, real pack-and-install. The publication receipt says
   so in its own `limitations` list.
