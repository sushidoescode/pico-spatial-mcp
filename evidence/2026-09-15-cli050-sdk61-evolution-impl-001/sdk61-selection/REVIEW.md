# SDK 6.1 selection — static compatibility boundary (Task S6)

| | |
| --- | --- |
| Date | 2026-09-15 |
| Worktree | `.worktrees/cli050-track-sdk-2026-09-15` (branch `track/cli050-sdk`) |
| Source SHA the work started from | `89ee9d02d1df8e65425f29bcf4ab16037deeb24f` (Tasks S1–S5 complete and reviewed) |
| Scope | host filesystem, `node`, `git`. Tests, one verifier script and this note only — no `src/**` change. |
| Not started at any point | `pico-cli`, any provider or service, Java, Gradle, an emulator, a device, a real SDK payload, a network request. |

Every row below is **structural** evidence in this repository's evidence ranking
(`structural` < `auto_judged` < `vision_verified` < `device_verified`). Nothing here is a runtime,
visual or native-acceptance claim, and nothing here establishes that a real SDK 6.1 payload, a
real Maven artifact or a real device behaves as described.

---

## Exact commands and results

Run in the worktree root, in this order.

```
$ npm run build                                                       # tsc, exit 0, no src change
$ node --test test/toolchain-resolution.mjs test/toolchain-consumers.mjs \
      test/projectidentity.mjs test/toolchain-cache.mjs \
      test/declarationcontext.mjs test/declarationcontext-installed.mjs
  ℹ tests 173   ℹ pass 173   ℹ fail 0
$ node test/preflight.mjs      Preflight test done. Failures: 0
$ node test/projectgen.mjs     Projectgen test done. Failures: 0
$ node test/vault.mjs          Vault test done. Failures: 0
$ node test/vaultdiff.mjs      Vault-diff test done. Failures: 0
$ node test/lint.mjs           Lint fixture test done. Failures: 3   # pre-existing, see below
$ node test/doors.mjs          Doors test done. Failures: 0
```

Per-suite: `toolchain-resolution` 48/48, `toolchain-consumers` 36/36, `projectidentity` 24/24,
`toolchain-cache` 32/32, `declarationcontext` 25/25, `declarationcontext-installed` 8/8.

`node test/docsmeta.mjs` (0 failures) and `node --test test/distribution-adoption.mjs` (41/43, the
same two counts as before this task) were also run, to confirm this task's new files change
neither gate.

### Failures seen during execution

| Failure | Where | Resolution |
| --- | --- | --- |
| `ReferenceError: toolchainIOFromTree is not defined` | first run of the combined fixture | the helper was reached through a scoped dynamic import that destructured only `macSdkTree`; both names are now destructured. |
| `["target-unresolved"] !== ["context-mismatch"]` | first run of the combined fixture | my expectation was wrong, not the code: a **declared-only** project identity never establishes a target artifact set, so it is refused before the BOM is compared. The test now asserts BOTH refusal shapes — declared-only → `target-unresolved`, resolved-with-a-different-BOM → `context-mismatch`. |
| `/var/…` vs `/private/var/…` (twice) | lint advisory block; relocated module data dir | both values are canonical (`realpath`) by design; the assertions now compare canonically. Not a defect. |
| `ERR_MODULE_NOT_FOUND … scripts/verify-sdk-compatibility-payload.mjs` | first run of `test/declarationcontext-installed.mjs` | the intended RED: the suite was written before the canary existed. |

### Pre-existing failures, untouched by this task

`node test/lint.mjs` reports 3 failures, all in the battery-inventory block and all owned by the
release track's R3 (already fixed on that branch, not merged here):

```
FAIL battery: package.json declares gates that gates.yml never runs: test:runrevision
FAIL battery: README.md claims 47 invocations / 46 suites; package.json + gates.yml say 49 / 48
FAIL battery: docs/COLLABORATORS.md claims 47 invocations / 46 suites; package.json + gates.yml say 49 / 48
```

`node --test test/distribution-adoption.mjs` is 41/43 on the same two inventory counts, before and
after this task. `npm run test:tarball` is known-red in this worktree by design and was **not**
run: the built payload now derives `data` as a required sibling directory while `package.json`
`files[]` does not yet ship it, which is the intended canary for the integration task below.

---

## Capability rows

A passing row names the exact test that proves it. Suite names alone are not evidence.

| # | Capability | Class | Result | Exact test |
| --- | --- | --- | --- | --- |
| 1 | **Structural 6.1 selection** — on a host carrying BOTH a 0.13 and a 6.1 install, every packer/editor consumer runs the 6.1 payload | structural (in-memory fixture) | PASS | `S6 matrix: every packer/editor consumer runs the SELECTED 6.1 binary on a host that also carries 0.13` (`test/toolchain-consumers.mjs`) |
| 2 | **Explicit-component refusal** — a missing root, a missing component, an uninstalled pin and a platform-unpublished component each fail as themselves and carry no binary | structural (in-memory fixture) | PASS | `S6 matrix: failed and missing selections are reported as themselves, never degraded to another binary` (`test/toolchain-consumers.mjs`) |
| 3 | **Project-BOM preservation** — a project's declared BOM is read, never rewritten, and never rounded from a dynamic version; no read path writes to a project tree | structural (temp-filesystem fixture) | PASS | `combined fixture: selected tools 6.1, project BOM 6.0.0, vault revision 0.13.3 and a dynamic-BOM project are four independent facts` (`test/declarationcontext.mjs`); generation side proved separately by `generation preserves the project BOM byte-for-byte while recording the 6.1 selection` (`test/projectgen.mjs`) |
| 4 | **Cache replacement** — adb and the emulator proto schema follow the selected installation inside one process; an explicit adb override fails closed with nothing else probed | structural (in-memory fixture + temp proto tree) | PASS | `S6 matrix: adb and the emulator proto schema follow the selected installation; adb resolution spawns nothing` (`test/toolchain-consumers.mjs`) |
| 5 | **Historical lookup** — a vault under a `6.1`-labelled directory still reports the `0.13.3` revision its `package.xml` declares; `vault_api` and `preflight_lint` stay `historical`/`unknown` and report the packaged index as present with 0 records | structural (temp-filesystem fixture) | PASS | `S6 matrix: vault and lint answers follow the selected tools root and stay historical without reviewed evidence` (`test/toolchain-consumers.mjs`) |
| 6 | **Target-matched authority** — an accepted mapping requires exact provenance, and does not outlive a changed or missing packaged basis | structural (temp-filesystem fixture) | PASS **at unit level only** | `a previously accepted mapping does not survive a changed or missing packaged basis, and comes back only when the exact bytes do` (`test/declarationcontext-installed.mjs`) |
| 6b | **Target-matched authority through a tool surface** | — | **UNREACHABLE TODAY, BY DESIGN** | No tool path can produce it: `vault_api` and `preflight_lint` read the project with `readProjectSdkIdentity(projectRoot)` and never accept caller-supplied `resolvedArtifacts`, so every tool-level context is `historical`/`unknown` (S5 concern 1). Row 6 is proven with SDK-owned objects, not through a door. |
| 7 | **CLI boundary** — a fabricated `{cliVersion, workspaceRoot, fingerprint}` hint selects only what is READ; the revision and the fingerprint come from local bytes, a hint-shaped identity is refused, and an unsupported transport stays `unavailable` | structural (in-memory fixture) | PASS | `a fabricated CLI version/fingerprint hint never becomes authority: only the local bytes decide, and an unsupported transport stays unavailable` (`test/declarationcontext.mjs`) |
| 8 | **Platform fixture — darwin** | structural (in-memory fixture) | PASS, **fixture-only** | `S6 matrix: every packer/editor consumer runs the SELECTED 6.1 binary on a host that also carries 0.13` (`test/toolchain-consumers.mjs`) |
| 9 | **Platform fixture — win32** (`.exe` payloads, drive root, editor refused) | structural (in-memory fixture) | PASS, **fixture-only** | `S6 matrix: the same mixed host on win32 and linux FIXTURES selects the 6.1 payload published for that platform` (`test/toolchain-consumers.mjs`); depth in `an explicit Windows drive root selects .exe payloads` (`test/toolchain-resolution.mjs`) |
| 10 | **Platform fixture — linux** (bare names, explicit root, editor refused) | structural (in-memory fixture) | PASS, **fixture-only** | same test as row 9; depth in `an explicit Linux root works even though Linux has no documented default` and `platforms with no verified default root never invent one` (`test/toolchain-resolution.mjs`) |
| 11 | **Payload discovery** — the packaged reviewed index and every referenced record/basis byte are present and hash-identical after relocation, and the installed module resolves them from its own URL | structural (temp-filesystem fixture) | PASS | `the canary verifies the packaged index and every referenced byte, resolving from packageRoot and never from the working directory` and `the relocated package loads its historical references through its own module URL, with no docs/ or test/ present` (`test/declarationcontext-installed.mjs`) |
| 12 | **Binary compatibility** — that a discovered 6.1 payload actually runs, or that the 0.13.3 declarations describe a 6.1 SDK | — | **UNEXECUTED** | Row 11 is payload DISCOVERY: names, presence and bytes. It says nothing about executability or API behaviour. |
| 13 | **Provider help vs semantic behaviour** | — | **UNEXECUTED** | No provider, knowledge service or `pico-cli` process was started in this task. The read-only discipline is pinned by `the canary reads only: it starts no process, opens no network, and never consults the working directory` (`test/declarationcontext-installed.mjs`) and `the module reads only; it never spawns a process, runs Gradle or the CLI, or writes to a project` (`test/declarationcontext.mjs`) — a source-text gate, which is evidence about the code, not about a provider. |
| 14 | **Scope of the "no legacy launch" claim** — rows 1–5 assert it over the operations they exercise, not over the whole server | structural (source-text gate) | PASS, with a named residue | `S6 matrix: the ONE legacy \`which adb\` probe left in the server is bounded to validate_toolchain and does not spread` (`test/toolchain-consumers.mjs`). `validateToolchain`'s own `findAdb()` (`src/toolchain.ts:483`) still shells out to `which adb` and then a version-joined platform-tools path, ignoring `$PICO_ADB` — a deferred S4 item recorded in the plan's progress notes, outside S6's tests-only scope. It is pinned by count, location and caller so a second consumer cannot pick the habit back up. |

### Rows that start UNEXECUTED and stay so until independently evidenced

| Row | Why it is not evidenced here |
| --- | --- |
| Real host binary probes | Nothing was executed. An "executable" in every fixture is a boolean flag on an in-memory node; no payload was launched, not even `--version`. |
| Artifact resolution against a real Gradle module cache | `hostDeclarationIO.artifactPath` was exercised only against a fixture `GRADLE_USER_HOME` (S5) and an explicit `(coordinate, sha256) -> path` table (S6). The real cache layout on this machine was never read. |
| SDK 6.1 native acceptance | No emulator, device, APK, capture or frame is involved. Nothing in this task may be cited as visual or device evidence. |
| Installed-tarball lifecycle | `npm pack` / extract / install was not run here. The relocated fixture is a hand-built directory, not a tarball; the real lifecycle belongs to the release track's gate. |
| Cross-platform support | Rows 9 and 10 are in-memory fixtures on a darwin host. They prove the selection LOGIC, not that this server has ever run on Windows or Linux. |

---

## Mutation evidence

The new suites were green on their first post-implementation run, so each claim was checked by
breaking the thing it claims. Every file was restored byte-identically afterwards (verified by
comparing the restored bytes to the original buffer) and `npm run build` was re-run.

Canary (`scripts/verify-sdk-compatibility-payload.mjs`), no rebuild needed:

| Mutation | Caught by |
| --- | --- |
| hash comparison removed | the basis-lifecycle test and the accepted-mapping test (2 failures) |
| data directory taken from the script's own location instead of `packageRoot` | 6 failures, including the cwd-independence test |
| a missing referenced file skipped silently | the basis-lifecycle test |
| a relative `packageRoot` accepted | the canary-discipline test |
| record-basis cross-check removed | the undeclared-basis test |
| `ok` hardcoded true | 3 failures |

Source (`src/**`, each built, run and restored — no source change is committed):

| Mutation | Caught by |
| --- | --- |
| `preflight.ts`: an explicit `$PICO_ADB` no longer stops the candidate walk | `S6 matrix: the preflight pico-sdk and adb rows read the selection, and their captured exec log launches nothing legacy` |
| `adb.ts`: a rejected explicit override falls through to PATH/bundled | `S6 matrix: adb and the emulator proto schema follow the selected installation; adb resolution spawns nothing` |
| `projectidentity.ts`: a dynamic catalog version taken as literal | `combined fixture: selected tools 6.1, project BOM 6.0.0, vault revision 0.13.3 and a dynamic-BOM project are four independent facts` |
| `toolchainselection.ts`: the OLDEST usable installation selected | 4 S6 tests, including the combined fixture and the packer matrix |

Every mutation was caught; none was MISSED. `git diff HEAD -- src/ package.json scripts/verify-tarball.mjs`
is empty after the sweep.

---

## Handoff — two edits this task deliberately did NOT make

Both belong to the release/integration owner; ownership boundaries kept them out of this commit.

1. `package.json` `files[]` must gain exactly `"data/sdk-compatibility"` (not `"data"`, and never
   `"docs"` or `"test"`). The current allowlist is
   `["dist","scripts","tools","briefs","appskeleton","unityskeleton","assets","GETTING_STARTED.md","TESTERS.md","SKILLS.md","DESIGN.md"]`.
2. `scripts/verify-tarball.mjs` must invoke the canary on the extracted package, after the `[M1]`
   sibling-directory loop, and fail when it does. The exact shape is in the S6 report.

Until edit 1 lands, `derivedSiblingDirs()` derives `data` from the built output and
`npm run test:tarball` fails with `payload MISSING: data/`. That red is the canary working.
