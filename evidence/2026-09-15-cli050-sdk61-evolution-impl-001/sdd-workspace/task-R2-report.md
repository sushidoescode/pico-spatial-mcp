# Task R2 — Rebuild changed source plugin caches without slowing unchanged startup

**Status:** DONE (with one disclosed boundary deviation — see "Boundary deviation" below, please review it first)
**Worktree:** `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-release-2026-09-15` (branch `track/cli050-release`)
**Commit:** `9f57e37` — `fix: refresh changed source plugin caches` (not pushed)
**Base:** `7f9a304` (Task R1 complete and reviewed)

---

## What I implemented

### `scripts/build-identity.mjs` — dependency identity + output-only verification

| Export | Behaviour |
| --- | --- |
| `dependencyIdentity(root)` | sha256 over sorted `` `<key>\0<sha256>\n` `` lines for `package-lock.json` bytes and `toolchain:node-major` — the same material formula `inputIdentity` uses. Returns `null` when there is no readable lockfile, because there is then nothing to be current against. |
| `DEPENDENCY_RECEIPT_NAME` | `.pico-dependencies.json` (root, gitignored, never packaged). |
| `dependencyReceipt` / `writeDependencyReceipt` | `{schemaVersion:1, dependencyIdentity, npmArgv}`. `writeDependencyReceipt` refuses to record an install with no readable lockfile. |
| `verifyDependencies(root)` | `{current, reasons[]}`, never throws. Not current for: missing `node_modules/`; unreadable/unparsable receipt; wrong `schemaVersion`; a receipt missing its identity **or the command that produced it**; an unreadable lockfile; an identity mismatch. |
| `verifyEmittedOutput(root)` | Output half only — the question an installed package can actually answer. |

`verifyBuild`'s byte/orphan/self-consistency checks were extracted into `emittedByteReasons(distDir, receipt)`; `verifyBuild` is now that plus the input-identity comparison, and `verifyEmittedOutput` is that alone. All 26 R1 tests pass unchanged against the refactor.

Deliberately **not** a walk of `node_modules`: hashing a 200 MB tree on every host start is the cost this whole change exists to avoid, and the lockfile is what `npm ci` is contracted to.

### `scripts/plugin-bootstrap.mjs` — the decision

`needsSourceBuild` is gone (it only ever answered "has this been built"). `sourceSetupPlan({dependenciesCurrent, buildCurrent})` returns the brief's arrays, each a fresh copy so a caller editing the plan it was handed cannot rewrite the next caller's. New `isSourceCheckout(root)` = `src/` dir **and** `tsconfig.json` file.

**Source checkout** (`prepareSourceCheckout`):
1. Read both receipts with **no lock**. Both current → return; the caller launches. Zero npm, zero compiler, zero CLI resolution, no lock file written.
2. Otherwise `withSourceSetup({root, waitMs: 30_000, clock})`, and **re-read both identities under the lease** — the owner we waited behind may already have done the whole job.
3. Execute the plan. `['ci','--no-audit','--no-fund']` → `npmLaunch` + the existing bounded runner, stdio `["ignore", 2, 2]`. `['run','build']` → **in-process** `buildSource({root, runCompiler, owner})` on the lease already held; spawning `npm run build` would send a second process to queue for the very lock we are standing on.
4. `installDependencies` reads the identity before, runs one bounded `npm ci`, re-reads it after, and **rejects** a lockfile that moved during installation (`BOOTSTRAP_LOCKFILE_RACED`) instead of recording misleading success. The receipt is written only after both.
5. The build action means "make the output current": after an install it is skipped if `verifyBuild` has *become* current, because `npm ci` restores the TypeScript version that is part of the build identity. (Tested; removing the branch fails that test.)
6. Any failed prerequisite throws — `main()` prints `pico-spatial-mcp bootstrap: <message>` on stderr and exits 1. No MCP child is launched.

**Installed artifact** (no `src/`/`tsconfig.json`): `verifyEmittedOutput` only. On failure, `BOOTSTRAP_PAYLOAD_INVALID` naming the reasons and asking for a reinstall — never tsc, never `npm ci`, never a lock file written into someone's `node_modules`.

`runCompilerImpl` defaults to R1's production `runCompiler` bounded by this bootstrap's `commandTimeoutMs` and using the injected `spawnImpl`. Its `terminateGraceMs` is deliberately left at build-source's 200 ms: that wait is a blocking `Atomics.wait` inside a signal handler, and 2 s of frozen Ctrl-C would be worse.

`scripts/build-source.mjs` needed **no change** — R1's `withSourceSetup` / `buildSource` / `runCompiler` exports already satisfied the contract, so I left it alone.

### `.gitignore`

One entry: `/.pico-dependencies.json`, with a comment saying why it is machine-local.

### Carried minors in `test/buildfreshness.mjs`

1. **`t.after` could signal a recycled pid.** The reap poll's result is now captured once into `compilerReaped`; the cleanup kill is skipped when the poll already watched the pid die. Comment states why: once it is dead the number is free for the OS to hand to someone else.
2. **The losing race arm kept the runner alive.** `clearTimeout(bound)` after the race. Measured, not asserted:

```
HEAD (git show HEAD:test/buildfreshness.mjs)  26/26 pass   real 10.38s
after the fix                                 26/26 pass   real  0.67s
```

---

## TDD evidence

### RED, layer 1 — the freshness API does not exist

```
$ node --test test/plugin-bootstrap-freshness.mjs
SyntaxError: The requested module '../scripts/build-identity.mjs'
  does not provide an export named 'DEPENDENCY_RECEIPT_NAME'
✖ test/plugin-bootstrap-freshness.mjs (29.193ms)
ℹ tests 1   ℹ pass 0   ℹ fail 1
```

### RED, layer 2 — the existing plan cannot express freshness

The brief's first assertion, against the code as it stood:

```
$ node -e '... sourceSetupPlan({dependenciesCurrent:true, buildCurrent:false}) ...'
dependenciesCurrent:true, buildCurrent:false -> [["ci","--no-audit","--no-fund"],["run","build"]]
ASSERTION FAILED: Expected values to be strictly deep-equal:   (expected [["run","build"]])
```

The old signature ignores both keys, so *every* input produced a full `npm ci` + build. That is the absent behaviour precisely: a cache whose build is already current cannot be expressed, and neither can one whose build alone is stale.

### GREEN

```
$ node --test test/plugin-bootstrap-freshness.mjs
✔ the setup plan is decided by dependency and build freshness, not by directory existence
✔ a source checkout is recognised by its sources and tsconfig, and an installed payload is not
✔ the dependency identity is a digest over the lockfile bytes and this Node major
✔ an install is only current when its receipt accounts for the lockfile on disk
✔ a packaged payload is verified from its receipt without any source
✔ an unchanged cache starts the server with no npm, no compiler and no setup lock
✔ a deleted dist is rebuilt without reinstalling dependencies
✔ a source edit rebuilds before the server starts
✔ a lockfile edit reinstalls, rebuilds and records the new dependency identity
✔ a cache with no trustworthy dependency receipt installs once
✔ restoring a deleted node_modules does not recompile output the install makes current again
✔ the install and the build it feeds share one setup lease
✔ the planned build runs the checkout's own TypeScript through this node binary with an explicit outDir
✔ a failed install ends bootstrap and never compiles or launches
✔ a failed compilation ends bootstrap, keeps the previous output and never launches
✔ a lockfile that changes during installation is rejected instead of recorded
✔ an installed package with an intact payload launches without npm or a compiler
✔ an installed package whose payload was tampered with refuses to launch and asks for a reinstall
✔ two cold bootstraps against one cache install once, build once, and never overlap
✔ two changed-lock bootstraps against one cache reinstall once and rebuild once
✔ a waiter that times out on the setup lease launches nothing
✔ a real cold bootstrap compiles, keeps npm and compiler chatter off stdout, then starts warm
ℹ tests 22   ℹ pass 22   ℹ fail 0      real 0.50s
```

Fixtures are real: real temp checkouts under `plugin cache ü 漢字`, real lockfiles, real receipts, real `wx` lock files, real emitted `.js`. npm, the compiler and the server are stand-ins driven by test-owned barriers; the 30 s lease deadline is exercised against an injected clock in microseconds. **No test runs a real `npm`, a real registry request or a real tsc.**

Same-owner build reentrancy and wrong-root/retired-lease rejection are covered by R1's suite (`only the exact active lease for the same root is reused`, `buildSource reuses a caller-held lease instead of deadlocking on itself`, `two concurrent builds under one lease are serialized`) — reused rather than duplicated, as directed. What is new here is bootstrap-specific: install and build sharing one lease (asserted by reading the lock's own token during both), and lockfile mutation during installation.

### Mutation probes — the tests are not vacuous

Each applied to a copy-backed source, run, then restored (`diff` clean each time):

| Mutation | Result |
| --- | --- |
| M1 plan ignores `buildCurrent` | ✖ plan test + both concurrency tests |
| M2 identities not re-read under the lease | ✖ both concurrency tests |
| M3 lockfile race during install not rejected | ✖ lockfile-race test |
| M4 packaged payload never verified | ✖ tampered-payload test |
| M6 a bare `node_modules` trusted as current | ✖ unknown-receipt test + `verifyDependencies` matrix |
| M9 build spawned as `npm run build` instead of in-process | ✖ 9 freshness tests **and** the Windows ComSpec test |
| "install made the build current" skip removed | ✖ deleted-node_modules test |

### A test defect the probes exposed, and fixed

M9 did not fail — it **hung the runner**. `concurrentBootstraps` awaited `compileGate.arrived` unbounded, so a regression in which the compiler is never called blocks forever; the same R1 hit in its round 3. Every barrier wait now goes through `reach(promise, what, 10_000)`:

```
M9, before hardening:  runner hung, killed by hand
M9, after hardening:   ✖ 9 tests in 10.34s, including "nothing ever reached the compiler"
```

---

## Real-repo evidence (not fixtures)

A mirrored cache of this repo — the three bootstrap scripts and the three root config files copied, `src/` and `dist/` copied, `node_modules` symlinked, the real TypeScript present — driven by the real `scripts/plugin-bootstrap.mjs` with a **poisoned `npm` first on `PATH`** that fails loudly if anything tries to install:

```
deps: true  build: true

# one real source edit, then a real bootstrap
REBUILD-AND-LAUNCH elapsed 3.217 s     EXIT=0   stdout bytes: 0
stderr: pico-spatial-mcp ready (stdio)          (no FORBIDDEN npm)

# immediately again
WARM-AGAIN        elapsed 0.176 s     EXIT=0   stdout bytes: 0
stderr: pico-spatial-mcp ready (stdio)          (no FORBIDDEN npm)

no .dist-staging-*, no .dist-backup-*, no .pico-source-setup.lock left in the cache
this repo afterwards: verifyBuild -> {"current":true,"reasons":[]}, git status unchanged
```

A packaged shadow root (`dist/` + `scripts/`, no sources), same poisoned npm: **exit 0, 0 bytes on stdout, `pico-spatial-mcp ready (stdio)` on stderr, npm never invoked.**

What the freshness check itself costs on this checkout (182 `.ts`, 182 `.js`, 56 kB lockfile), mean of 20:

| | ms |
| --- | --- |
| `verifyBuild` | 9.10 |
| `verifyDependencies` | 0.06 |
| `dependencyIdentity` | 0.03 |
| `verifyEmittedOutput` | 4.20 |

**Timings are observations from these runs on this machine, not promises about any host's MCP timeout.** Fixture timings recorded by the suite itself: `warm 0.42ms, e2e cold 134ms, e2e warm 47ms, e2e source-edit 76ms`.

**The packaged-path assumption, verified against a real pack** rather than assumed — `npm pack --dry-run --offline`, top-level entries:

```
appskeleton assets briefs dist scripts tools unityskeleton
top-level src/ entries: 0      tsconfig.json / package-lock.json entries: 0
dist/build-receipt.json: 50.9kB (present, so verifyEmittedOutput has what it needs)
```

(The 33 `src/` hits in the file list are all under `appskeleton/`.)

---

## Test results

| Command | Result |
| --- | --- |
| `npm run build` | `published 182 file(s) for source b65f30ff49e0` |
| `node --test test/plugin-bootstrap-freshness.mjs` | **22/22 pass**, exits in 0.50s |
| `node --test test/buildfreshness.mjs` | **26/26 pass**, exits in 0.67s (was 10.38s) |
| `node --test test/distribution-adoption.mjs` | 41 pass / **2 fail — the known baseline** |
| `node --test test/run-battery.mjs` | 8/8 pass |
| `node test/docsmeta.mjs` | Failures: 0, exit 0 |

The two `distribution-adoption` failures are the documented inventory-count cases (`{linux:44}` vs 45; 46 vs 48 scripts). Proven identical rather than asserted: I diffed the whole failure block against the pre-change baseline and **the only differences are line numbers** my edits shifted. No other failure appeared.

---

## Boundary deviation — please review this first

**I edited one test outside my stated ownership: `test/distribution-adoption.mjs`'s `documented portable and Claude token contracts launch from a hostile cwd` (a host-manifest section).** I would not have, except that leaving it violated a harder constraint, and I could not leave both intact.

**What happened.** That test expands `${PLUGIN_ROOT}` to **`repoRoot`** and runs the real bootstrap against this working checkout three times. Under the new decision the checkout is a source checkout with no dependency receipt, so the bootstrap did exactly what the brief specifies: it took the lease and ran **a real `npm ci` into the developer's own `node_modules`**. Not inferred — measured:

```
node_modules/.package-lock.json   rewritten 04:31:24
node_modules/typescript, .bin, zod, eventsource, …   all mtime 04:31:24
.pico-dependencies.json           written  04:31:24
that test's duration: 503ms at baseline -> 1456ms
```

That breaks my binding constraint ("Never run a real `npm install`/`npm ci` from a test"), and in CI it is worse than slow: `gates.yml:134` runs `test:distribution-adoption`, the spawn has `timeout: 10_000`, and a clean checkout has no receipt — so a full `npm ci` inside that 10 s window is a coin-flip failure on every run.

**What I changed, and what I did not.** Every manifest assertion is byte-for-byte untouched — `launcher.command === "node"`, `deepEqual(launcher.args, ["${TOKEN}/scripts/plugin-bootstrap.mjs"])`, `Object.hasOwn(launcher,"type")`, the cursor args, the clean-stdout and exit-code assertions. The **only** change is what the token expands to for the spawn: an installed plugin root (`createLaunchableCacheRoot`) — the three bootstrap scripts as real files beside a symlinked `dist/` and `node_modules`. That is the shape a consumer actually has, so **the real server still starts from it**, and I added an assertion that is strictly new coverage: a `PATH` whose `npm` prints `FORBIDDEN npm` and exits 66, plus `assert.doesNotMatch(result.stderr, /FORBIDDEN npm/)`. Launching a consumer's cache can no longer quietly install; it fails loudly.

**Alternative I rejected:** loosening `verifyDependencies` to accept npm's own `node_modules/.package-lock.json` as proof. It would make the first start free for every existing cache and for CI, but it is a second source of truth with its own equality rules, and resolution 1 pinned the schema. That is your call, not mine.

I also had to fix `bootstrap forwards SIGTERM to the MCP child` (unambiguously a bootstrap section) for the same root cause: its fixture was `node_modules/` + `dist/index.js` with no receipt, which the new code correctly reads as a source-less payload it cannot vouch for. It now builds a real packaged payload via `writePackagedPayload` (+ `writeReceipt`), so it additionally proves the installed-package launch path end to end.

**After the fix, the whole suite mutates nothing:** no `.pico-dependencies.json` in the repo, `node_modules/.package-lock.json` mtime unchanged at 04:31:24, `git status` shows only my six files.

---

## Other `test/distribution-adoption.mjs` bootstrap-section updates

- **`bootstrap root/platform/prerequisite decisions …`** — `needsSourceBuild` asserts replaced by `isSourceCheckout` asserts; the four `sourceSetupPlan` asserts moved to the new keys. Same shape, same count.
- **Windows ComSpec test** — extended, not weakened. Its fixture is now a real cold source checkout under `plugin cache ü 漢字` (canonical temp root, because the lease resolves symlinks). It still asserts ComSpec quoting, `["ignore",2,2]`, `cwd`, `env`, `shell !== true`. **Added:** the compiler launch is `process.execPath` + the absolute `node_modules/typescript/bin/tsc` + `-p <abs tsconfig>` + `--outDir <scratch under root>`; `assert.equal(launches.some(args include "run build"), false)`; no scratch or lock left behind.
- **`a non-timeout npm failure …`** — fixture extended to a real source checkout (`writeSourceCheckout`, which also copies `build-identity.mjs` and `build-source.mjs`, since the bootstrap now imports them). All original assertions intact.
- **`cold bootstrap keeps npm on stderr …`** — the fake npm's `run build` branch is gone (the build is in-process now); its `ci` branch instead provisions a stand-in `tsc` that really emits, so the **real** `runCompiler` runs. **Added:** `TSC_STDOUT` must appear on stderr and never stdout; the cold run compiles exactly once; the warm run runs neither npm nor the compiler; and a third run after a source edit rebuilds (compiler count 2) without reinstalling (npm log empty) and the new bytes reach `dist/index.js`. That last one is the regression this task exists to close, proven in a real subprocess.

---

## Files changed

| File | Change |
| --- | --- |
| `scripts/build-identity.mjs` | +148/−17 — `dependencyIdentity`, receipt read/write, `verifyDependencies`, `verifyEmittedOutput`, `emittedByteReasons` extraction |
| `scripts/plugin-bootstrap.mjs` | +166/−45 — identity-based `sourceSetupPlan`, `isSourceCheckout`, `prepareSourceCheckout`, `installDependencies`, `requireIntactPackagedPayload`, `setupWaitMs`/`clock`/`runCompilerImpl` |
| `test/plugin-bootstrap-freshness.mjs` | **new**, 821 lines — 22 tests |
| `test/distribution-adoption.mjs` | +230/−40 — bootstrap sections above, three new helpers, one disclosed host-manifest launch-target change |
| `test/buildfreshness.mjs` | +16/−5 — the two carried minors |
| `.gitignore` | 1 entry + comment |
| `scripts/build-source.mjs` | **unchanged** — R1's exports already satisfied the contract |

---

## Self-review

**Completeness.** Every brief checkbox and every controller resolution is implemented and covered by a test that fails when the behaviour is removed. Both carried minors are fixed, one with a before/after measurement. Resolution 5's list is complete: concurrent cold, concurrent changed-lock, exactly one install and one build, no overlap, both callers observing the same receipt bytes, a timed-out waiter launching nothing (and not stealing the lock), lockfile mutation during installation; reentrancy and lease rejection reused from R1.

**Discipline.** `build-source.mjs` untouched. No `package.json`, `.github/**`, `run-battery.mjs`, `verify-tarball.mjs`, README/AGENTS/policy doc or `src/**` change. The managed-CLI policy block is not quoted, paraphrased or referenced. Node 20 APIs only (nothing newer than `fs.cpSync`/`AbortSignal`; my local Node is v25, CI runs 20 and 22 — flagged as a residual risk below). Hostile space/Unicode paths and the Windows `npmLaunch` path preserved and extended.

**Testing.** Real files, real locks, real receipts throughout; no `fs` mocking. Pristine output — the only line the suite writes is the deliberate `bootstrap timings:` summary. Both suites exit promptly (0.50s / 0.67s); no lingering timers, no orphan children (checked `ps` after the probes; none). All mutation probes restored with a clean `diff`.

**The three things I was told to verify:**
- *Warm unchanged startup makes zero npm/build calls and resolves no CLI* — proven twice: in-process (`kinds(launches)` is exactly `["launch"]`, compiler calls 0, no lock file) and against the real repo mirror with a poisoned `npm` on `PATH` (0.176 s, exit 0, npm never invoked). "Resolves no CLI" is structural: `plugin-bootstrap.mjs` imports only `node:*`, `build-identity.mjs` and `build-source.mjs`, and touches nothing under the managed CLI store; CLI resolution stays lazy inside the server it launches.
- *npm chatter never reaches stdout* — `stdio: ["ignore", 2, 2]` asserted on the install launch, and in subprocess runs `NPM_STDOUT`, `NPM_STDERR` and `TSC_STDOUT` all land on stderr while stdout is exactly `MCP_STDOUT\n` (0 bytes with the real server).
- *A tarball consumer never sees tsc or `npm ci`* — asserted in-process, plus the error message for a bad payload is asserted **not** to mention `npm ci`/`tsc`/TypeScript, plus the real `npm pack` file list confirms no `src/` or `tsconfig.json` ships.

---

## Concerns

1. **The boundary deviation above needs your sign-off.** If you would rather keep that test pointed at `repoRoot`, the only other way to stop it installing is to widen `verifyDependencies` (e.g. accept `node_modules/.package-lock.json`), which is a design change to resolution 1.

2. **Every existing cache pays one `npm ci` on its next start.** This is resolution 3 working as specified — Claude Code pre-installs with `npm ci --ignore-scripts` and leaves no receipt, so the first start after this ships cannot account for `node_modules` and installs once. Correct, one-time, and bounded, but it is a real first-launch cost on a path that is otherwise fast, and it is worth saying so in release notes rather than letting a tester discover it.

3. **An old tarball with no `dist/build-receipt.json` will now refuse to launch** with reinstall guidance instead of starting. Receipts only exist from R1 onward. This is exactly what the brief asks for ("fail with reinstall guidance if payload validation fails"), and hosts install from GitHub (source checkouts), so it affects only hand-built `.tgz` testers on a pre-R1 build — but it is a hard stop, not a warning.

4. **I could not run the suites on Node 20 or 22.** This machine has v25.8.1. I used only APIs available in 20 and reviewed the diff for newer syntax, but that is source review, not a green run on a CI Node.

5. **`npm run test:tarball` was not run** — it installs a tarball from the network. The offline half (`npm pack --dry-run --offline`) is above and confirms the packaged shape the new path depends on; the networked half remains unverified.

6. **The dependency identity does not see a hand-edited `node_modules`.** Deleting a package from `node_modules` without touching the lockfile leaves `verifyDependencies` current. Detecting that costs a tree walk on every start, which is the cost this design exists to avoid; the honest statement is that the receipt binds the install to its lockfile, not to the bytes on disk.

7. **`test/distribution-adoption.mjs` now imports `writeReceipt` from `../scripts/build-identity.mjs`** (a new top-level import) to build the packaged fixtures. Small, but it is a new coupling between that suite and the build scripts.

---

# Fix round 1 — accept npm's own record of an install as evidence

**Commit:** `685e8d9` — `fix: accept npm's hidden lockfile as dependency evidence` (not pushed)
**Finding:** Important — `scripts/build-identity.mjs:131`. Accepted as correct. It is also concern (2) of my own report, escalated from "worth release notes" to "must not ship", which is the right call: I under-rated it.

## Reproducing it first

The finding is about *this* checkout, so I measured it here before changing anything:

```
receipt present: false
main package-lock.json   lockfileVersion 3, 129 packages + the root "" entry
node_modules/.package-lock.json  lockfileVersion 3, 129 packages, no root entry
entries only in main: []      entries only in hidden: []
diffs across version/resolved/integrity/dev/optional, all 129 entries: 0
```

So npm's own record accounts for this tree exactly, and the old code still returned
`{current:false, reasons:["… is unreadable (ENOENT) …"]}` — a full `npm ci` to learn what npm had
already written down, and nothing at all on a host with no network.

## What changed

**`matchesHiddenLockfile(root)` (new, `build-identity.mjs`).** Pure and local. Same
`lockfileVersion`; the same entry set with the root `""` entry excluded from both (npm omits it from
its own record); per entry only `version`, `resolved`, `integrity`, `dev`, `optional`, compared
*as present* — a field in one file and not the other is a mismatch. Everything else an entry carries
(`license`, `engines`, `bin`, `funding`, `dependencies`, `peerDependenciesMeta`) describes the
package rather than identifying what landed, and npm is free to spell it differently in the two
files. Any read or parse failure, a missing `packages` map, an entry that is not an object, or an
entry either file does not list returns `matches:false` with a reason **naming the hidden lockfile
and the entry that disagreed**.

**`verifyDependencies` now has two witnesses.** The receipt first — the cheap one, and the only one
a warm start pays for. Failing that, npm's record. Only when neither can speak is the tree unknown,
and the reasons from both are returned together. The verdict gained `acceptedBy`
(`"receipt"` | `"hidden-lockfile"` | `null`) and `identity`, so the caller can tell a receipt-fast
start from one that still owes a write.

**Adoption, under the lease (`plugin-bootstrap.mjs`).** The lock-free fast path is now
`acceptedBy === "receipt" && verifyBuild().current`. A tree accepted on npm's evidence takes the
lease once, writes `{schemaVersion:1, dependencyIdentity, source:"hidden-lockfile"}` — **no
`npmArgv`, because we cannot name a command we never ran** — and re-reads the verdict afterwards, so
a receipt that does not verify simply leaves us where we were rather than asserting anything. The
write is best effort with a stderr note on failure: the evidence that accepted the tree is already
good, so failing to write it down must never be why a server does not start.

**Receipts record their evidence.** `source: "npm-ci" | "hidden-lockfile"`. `writeDependencyReceipt`
refuses an unknown source, and refuses an `npm-ci` receipt with no `npmArgv`. A receipt with no
`source` at all is read as `npm-ci` — the only thing that wrote receipts before this round — so
nothing written by `9f57e37` is invalidated.

**The two smaller repairs the controller asked for in the same pass:**
- The missing-receipt reason is now `no install has been recorded here yet (.pico-dependencies.json does not exist)`. It is the first string a user sees, and "unreadable (ENOENT)" read like corruption.
- **The post-install build question was one-directional.** `installed && verifyBuild().current → skip` could drop a planned build the install had satisfied, but could not add one the install had *invalidated* — and `npm ci` moves the installed TypeScript version, which is part of the build identity. The plan is now consumed as `installing = plan.some(isInstallAction)` then `mustBuild = installing ? !verifyBuild().current : plan.some(isBuildAction)`: after an install the question is simply asked again, in both directions.

## Covering tests (5 new, 27 total)

| Test | Proves |
| --- | --- |
| `npm's own record of the install is accepted when our receipt cannot speak` | acceptance with metadata deliberately differing between the two files, plus **nine** rejection cases, each asserted on its own reason: a changed version, a resolution field in only one file, an entry npm has that the lockfile does not, an entry the lockfile has that npm does not, a non-object entry, a different `lockfileVersion`, no `packages` map, unparsable JSON, no record at all. Also that a current receipt still answers *as* a receipt. |
| `a cache npm installed and we did not starts with no npm, records it once, then is receipt-fast` | the finding's own scenario: zero npm, zero compiler, receipt written with `source:"hidden-lockfile"` and **no `npmArgv`**, lease released — then npm's record is **deleted** and the second start still needs nothing, which is what makes "receipt-fast" a claim rather than a hope |
| `a single changed package in npm's record sends the cache through one install` | one `npm ci`, and the receipt that replaces it says `source:"npm-ci"` |
| `a record npm wrote for another lockfile version, or no record we can parse, is not evidence` | `lockfileVersion: 2` and a truncated write each produce exactly one install |
| `an install that changes the installed TypeScript rebuilds output that was current before it` | the one-directional fix: the plan is `[ci]` only, the install moves TypeScript 5.6.2 → 5.7.3, and the log is `install:start install:end compile:start compile:end launch:start launch:end` |

Updated rather than added: `a cache with no trustworthy dependency receipt installs once` is now
`a cache with neither a receipt nor npm's own record installs once` and asserts the hidden lockfile
is absent, because "no receipt" is no longer the same thing as "unknown"; the `verifyDependencies`
matrix gained the new ENOENT wording, `acceptedBy`, the recorded `source`, and an unknown-source
receipt; and the installed-package test now **plants a hidden lockfile** to prove the source-less
branch still cannot reach npm.

Fixtures now carry real `packages` maps — `lockfileFor()` writes the root entry plus per-entry
`license`/`engines`/`funding` that `writeHiddenLockfile()` deliberately omits, so "only the
resolution fields count" is a property the fixtures would break if it were not true.

### Mutation probes

| Mutation | Result |
| --- | --- |
| N1 `matchesHiddenLockfile` always matches | ✖ 8 tests |
| N3 npm's record accepted but never written down | ✖ the receipt-fast test |
| N4 post-install build question left one-directional | ✖ the TypeScript-change test |
| N5 compare every field instead of the resolution projection | ✖ 2 tests |
| N6 the root `""` entry not excluded | ✖ 2 tests |
| N7 ENOENT receipt reported as corruption again | ✖ the matrix test |

All restored with a clean `diff`.

## Commands and output

```
$ npm run build
build-source: published 182 file(s) for source b65f30ff49e0

plugin-bootstrap-freshness   exit=0  tests 27  pass 27  fail 0
buildfreshness               exit=0  tests 26  pass 26  fail 0
distribution-adoption        exit=1  tests 43  pass 41  fail 2
    ✖ distribution metadata records platform-exact full surfaces, … 46 test suites plus smoke
    ✖ the 47 named gate invocations are assigned to 44 Linux, … lanes
run-battery                  exit=0  tests 8   pass 8   fail 0
docsmeta                     exit=0  Docs/metadata gate done. Failures: 0
```

The two `distribution-adoption` failures are the known baseline reds, unchanged.

**This checkout, the finding's own case:**

```
receipt present: false
verifyDependencies: {"current":true,"acceptedBy":"hidden-lockfile","reasons":[]}
matchesHiddenLockfile cost: 0.25 ms     verifyDependencies (hidden-lockfile path): 0.26 ms
```

**End to end on a mirror of this repo, with `npm` poisoned on `PATH`** (a stub that prints
`FORBIDDEN npm` and exits 66) and no receipt — i.e. an offline host meeting a pre-existing cache:

```
receipt present: no        npm's own record present: yes

FIRST-START  elapsed 0.199 s   EXIT=0   stdout bytes: 0   stderr: pico-spatial-mcp ready (stdio)
receipt after: {"schemaVersion":1,"dependencyIdentity":"a520d790fabc…","source":"hidden-lockfile"}

SECOND-START elapsed 0.184 s   EXIT=0   stdout bytes: 0   stderr: pico-spatial-mcp ready (stdio)

no .dist-staging-*, no .dist-backup-*, no .pico-source-setup.lock left
this repo afterwards: git status unchanged, no .pico-dependencies.json written into it
```

Before this round the same run would have been a full `npm ci`, and on that poisoned `PATH` it would
have failed outright.

## Files changed

| File | Change |
| --- | --- |
| `scripts/build-identity.mjs` | +163/−41 — `matchesHiddenLockfile`, `resolutionMismatch`, `readJsonFile`, `receiptVerdict` extraction, `ACCEPTED_BY` / `RECORDED_SOURCE`, `source` in the receipt, the ENOENT wording |
| `scripts/plugin-bootstrap.mjs` | +63/−24 — `adoptInstalledDependencies`, the `acceptedBy` fast path, symmetric post-install build question, `isInstallAction`/`isBuildAction` |
| `test/plugin-bootstrap-freshness.mjs` | +196/−16 — 5 new tests (27 total), lockfile fixtures with real `packages` maps, `writeHiddenLockfile` |

Nothing else was touched: no ledgered Minor items, no `build-source.mjs`, no `package.json`, no docs.

## Notes

1. **Concern (2) of my original report is now resolved**, not merely mitigated: no existing cache pays an install, and an offline host starts. Concern (3) (a pre-R1 tarball with no build receipt refuses to launch) still stands — the packaged branch has no equivalent second witness, and npm's record cannot speak for `dist/` bytes.
2. **My approved shadow-root change to the manifest-launcher test is now belt *and* braces.** With this round in place, pointing that test at `repoRoot` would no longer install — but the shadow root also covers the installed-package launch path and pins "launching a consumer's cache runs no npm", so I left it. Reverting it would lose coverage, not just churn.
3. **The comparison is a projection, so it is deliberately blind in one direction**: a package whose `resolved`/`integrity`/`version` all match but whose *contents* were edited by hand in `node_modules` is still accepted. That is the same blindness the receipt has, and closing it costs a tree walk on every start — the cost this whole design exists to avoid.
4. **Cheap enough to be unconditional**: 0.25 ms on this checkout's 129 packages, and only on the path where the receipt could not answer.
