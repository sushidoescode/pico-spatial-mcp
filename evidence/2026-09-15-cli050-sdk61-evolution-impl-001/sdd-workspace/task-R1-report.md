# Task R1 — Bind a clean successful build to its source

**Status:** DONE
**Worktree:** `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-release-2026-09-15` (branch `track/cli050-release`)
**Commit:** `bfc123e` — `fix: bind clean build output to source identity` (not pushed)
**Base:** `4478238`

---

## What I implemented

### `scripts/build-identity.mjs` — digests and receipts

| Export | Behaviour |
| --- | --- |
| `inputIdentity(root)` | `{schemaVersion:1, sha256, files:[{path,sha256}]}` over every `.ts` under `src/`, plus `package.json`, `package-lock.json`, `tsconfig.json`, the installed TypeScript version and this Node major. Sorted, `/`-separated relative paths. |
| `outputIdentity(outDir)` | Same shape over the emitted tree, **excluding the receipt itself**. |
| `buildReceipt` / `writeReceipt` | Writes `dist/build-receipt.json`: `schemaVersion:1`, `input:{sha256,files}`, `output:{sha256,files}`, `typescript`, `nodeMajor`. |
| `verifyBuild(root)` | `{current, reasons[]}`. Never throws. |
| `installedTypeScriptVersion`, `nodeMajor` | Small helpers used by both. |

Digest material is exactly the brief's formula — `` `${path}\0${sha256}\n` `` joined, then sha256 — so a rename moves the digest as surely as a byte change.

The two toolchain facts ride in the same sorted list under `toolchain:typescript` and `toolchain:node-major`. Collision is structurally impossible: the file set is a *closed* enumeration (`src/**` + three named root files), never an arbitrary walk, so no real entry can ever be spelled `toolchain:…`.

`verifyBuild` reports `current:false` with a reason for each of: missing `dist/`; unreadable receipt; unparsable receipt; wrong `schemaVersion`; receipt missing its input/output identity; input digest mismatch; a listed output file missing; a listed output file whose bytes changed; an extra `.js` under `dist/` the receipt does not list (orphan); and a receipt whose own file list does not reproduce its recorded output digest.

### `scripts/build-source.mjs` — compilation and publication

| Export | Behaviour |
| --- | --- |
| `withSourceSetup({root, owner?, waitMs=30000, clock?}, work)` | Holds `.pico-source-setup.lock` (exclusive `wx`, JSON `{pid, token}`) for the canonical root while `work(lease)` runs. |
| `buildSource({root, runCompiler?, owner?})` | Compile → recheck identity → write receipt → publish. |
| `runCompiler({root, outDir, timeoutMs?, spawn?})` | Production compiler. |
| `publishStaging(root, staging)` | The atomic swap (exported as the seam that lets the restore path be tested with real renames). |
| `assertOwnedScratch(root, target, prefix)` | The ownership guard every destructive step goes through. |
| `buildSourceCli(root)`, `LOCK_NAME`, `STAGING_PREFIX`, `BACKUP_PREFIX` | CLI entry and names. |

**Lease model.** Leases live in a module-level `WeakMap` keyed by the lease object itself, so a caller can *hold* one but never *forge* one. The lease is a frozen opaque token that does not expose the root. A nested call passing back the exact active lease for the same canonical root reuses it without touching the lock; a string, a plain object, a retired lease, or an active lease for another checkout is rejected.

**Waiting.** An independent writer polls every 50 ms against the injected clock (default: monotonic `performance.now()` + `setTimeout`) until `waitMs`, then throws naming the lock path and the holder's pid. It never deletes a lock it does not own. Release re-reads the ownership record and unlinks only on a token match.

**Publication.** Compile into `.dist-staging-<random>`; recheck `inputIdentity` and reject a mid-build source change; write the receipt into staging; rename `dist` → `.dist-backup-<random>`, then staging → `dist`; remove the backup only after the swap lands.

**Compiler.** `process.execPath` + `<root>/node_modules/typescript/bin/tsc -p <root>/tsconfig.json --outDir <staging>`, `shell:false`, 10-minute bound, both child streams forwarded to **stderr** (MCP hosts own stdout). Resolves only on exit 0.

### `package.json` / `.gitignore`

`"build": "tsc"` → `"build": "node scripts/build-source.mjs"` — the only change to the file. `prepack` (`prepack-clean && npm run build`) is untouched and still works. `.gitignore` gains only `/.pico-source-setup.lock`, `/.dist-staging-*`, `/.dist-backup-*`.

---

## TDD evidence

### RED — `test/buildfreshness.mjs` written first, implementation absent

```
$ node --test test/buildfreshness.mjs

Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'/Users/.../cli050-track-release-2026-09-15/scripts/build-identity.mjs'
imported from /Users/.../cli050-track-release-2026-09-15/test/buildfreshness.mjs
    at finalizeResolution (node:internal/modules/esm/resolve:271:11)
  code: 'ERR_MODULE_NOT_FOUND',

✖ test/buildfreshness.mjs (28.135166ms)
ℹ tests 1   ℹ pass 0   ℹ fail 1
```

Expected, and expected in this exact form: the suite imports `../scripts/build-identity.mjs` and `../scripts/build-source.mjs` directly, never `../dist/*.js`, so a missing export fails on its own merits and cannot be masked by stale build output — which is the failure mode this whole task exists to close.

### GREEN

```
$ node --test test/buildfreshness.mjs
✔ source edits change the input identity and invalidate the receipt
✔ the input identity is a sorted, deterministic digest over sources, config, lockfile and toolchain
✔ a successful build publishes dist with a portable receipt and no leftover scratch
✔ removing a source removes its emitted module on the next successful build
✔ lockfile and tsconfig edits invalidate the receipt
✔ the installed TypeScript version participates in the identity
✔ a failed compilation preserves the previously published output
✔ a source change during compilation is rejected and the old output survives
✔ tampered, missing and orphaned output invalidates the receipt
✔ a missing, unparsable or half-published build is never current
✔ an independent writer waits for the lock, then fails without stealing it
✔ a waiting writer proceeds once the holder releases the lock
✔ only the exact active lease for the same root is reused
✔ buildSource reuses a caller-held lease instead of deadlocking on itself
✔ the production compiler runs the checkout's TypeScript through this node binary
✔ a failed publication restores the previous dist and keeps no backup behind
✔ every destructive step refuses paths the build does not own
ℹ tests 17   ℹ pass 17   ℹ fail 0
```

Tests are hermetic: `fs.mkdtempSync` checkouts with a real `package.json` / lockfile / `tsconfig.json` / `src/`, a stand-in compiler that genuinely emits one file per source (so removals, tampering and orphans are real files), and an injected clock so the 30-second deadline is exercised in microseconds. No sleeps, no mocks of `fs`.

### Mutation probes — proof the tests are not vacuous

Each mutation was applied to a copy-backed source, run, then reverted (final state re-verified at 17/17):

| Mutation | Suite result |
| --- | --- |
| orphan detection disabled | ✖ tampered, missing and orphaned output invalidates the receipt |
| lease validation always passes | ✖ only the exact active lease for the same root is reused |
| mid-build identity recheck removed | ✖ a source change during compilation is rejected and the old output survives |
| backup restore on failed publication removed | ✖ a failed publication restores the previous dist and keeps no backup behind |
| ownership guard disabled | ✖ every destructive step refuses paths the build does not own |

---

## Real-repo verification (not fixtures)

```
$ npm run build
> node scripts/build-source.mjs
build-source: published 182 file(s) for source b65f30ff49e0     (3.2s)

$ verifyBuild(cwd)  ->  {"current":true,"reasons":[]}
dist: 182 .js + build-receipt.json;  no .dist-staging-*, no .dist-backup-*, no lock left
```

**The orphan this task exists to kill, demonstrated end to end on the real checkout:**

```
$ echo "// stale output from a deleted source" > dist/orphan-check.js
$ verifyBuild(cwd)
{ "current": false,
  "reasons": ["dist/orphan-check.js is an orphan: no build emitted it"] }
$ npm run build
build-source: published 182 file(s) for source b65f30ff49e0
$ test -e dist/orphan-check.js  ->  gone
$ verifyBuild(cwd)  ->  {"current":true,"reasons":[]}
```

**stdout stays clean** (the script's own messages go to stderr, so a host bootstrap that owns stdout is safe):

```
$ node scripts/build-source.mjs 2>/dev/null
(no output)
```

**A failing build fails loudly** — the two scripts copied into a throwaway checkout with no TypeScript:

```
$ node <fixture>/scripts/build-source.mjs
build-source: no typescript compiler at <fixture>/node_modules/typescript/bin/tsc; run npm ci in <fixture> first
CLI EXIT=1
no dist, no lock left behind
```

**prepack chain intact** (`npm pack --dry-run`, offline):

```
> node scripts/prepack-clean.mjs && npm run build
prepack-clean: nothing to remove
build-source: published 182 file(s) for source b65f30ff49e0
npm notice total files: 301        verifyBuild after pack: {"current":true,"reasons":[]}
```

**Receipt carries no host identity:** `grep -c "$HOME" dist/build-receipt.json` → 0; the suite additionally walks every string in the receipt asserting none is absolute, none equals the checkout path, and none matches an ISO timestamp.

---

## Regression checks

| Command | Result |
| --- | --- |
| `node --test test/buildfreshness.mjs` | 17/17 pass |
| `node --test test/run-battery.mjs` | 8/8 pass |
| `node test/docsmeta.mjs` | Failures: 0, exit 0 |
| `node --test test/prompts.mjs` (a `dist/`-importing suite) | 3/3 pass |
| `node --test test/distribution-adoption.mjs` | 41 pass / **2 fail — pre-existing** |
| `node test/lint.mjs` | **3 FAILs — pre-existing** |

The five failures are the ones AGENTS.md already documents ("`test:runrevision` runs in no workflow, and the meta-gate that should catch that is itself red"). I proved they are not mine rather than asserting it: I swapped in `git show HEAD:package.json`, re-ran `distribution-adoption`, got the identical **41 pass / 2 fail with identical counts** (`linux: 45` vs expected 44; the same `test:` script list), and restored my file byte-identically. The `test:` script count is 48 at HEAD and 48 now — I added no npm script — and `test/lint.mjs:90` filters to `name.startsWith("test:")`, so the `build` script is outside every failing assertion.

---

## Files changed

| File | Change |
| --- | --- |
| `scripts/build-identity.mjs` | **new**, 178 lines — digests, receipt, `verifyBuild` |
| `scripts/build-source.mjs` | **new**, 225 lines — lock/lease, compiler, staging, publication, CLI |
| `test/buildfreshness.mjs` | **new**, 413 lines — 17 hermetic tests |
| `package.json` | one line: `"build": "tsc"` → `"build": "node scripts/build-source.mjs"` |
| `.gitignore` | 3 entries + comment: lock, staging, backup |

---

## Self-review findings

Two came out of review rather than out of a failing test, and both are fixed:

1. **The failure path could destroy the previous `dist/`.** My first draft, when the staging→`dist` rename failed *and* the backup restore also failed, fell through to `removeOwnedScratch(backup)` — deleting the only surviving copy of the previous output. A build must never be the reason output disappears. Now the backup is never removed on the failure path: if the restore cannot run, the backup is kept and its name is included in the thrown error so it can be renamed back by hand. Covered by *a failed publication restores the previous dist and keeps no backup behind*, and mutation-probed.

2. **The "cleanup cannot cross the checkout" guard was unreachable from outside.** My first attempt to test it proved the wrong thing — a foreign staging tree is *renamed*, not deleted, so the guard never fired. I extracted `assertOwnedScratch(root, target, prefix)` (rejects anything whose parent is not the root, whose basename lacks the prefix, or which is a bare prefix with no random suffix), routed both the removal and `publishStaging` through it, and tested it directly against six rejection cases plus a foreign staging tree that must survive untouched.

Also tightened during review:

3. **A receipt is untrusted input.** `verifyBuild` read whatever path the receipt named; a tampered receipt could point at `../../etc/hosts`. Entries that are absolute or contain a `..` segment are now rejected as malformed (asserted in the missing/unparsable test).
4. **Cleanup can no longer mask a real failure.** The `finally` that removes staging is wrapped, so a cleanup error is reported to stderr instead of replacing the error that brought us there.
5. `readReceipt` now names the error code instead of always claiming the receipt "is missing".

Checked and clean: no receipt leaks a home path, checkout path, hostname or timestamp; no cleanup path can touch anything outside the checkout; a failed, interrupted or half-published build is never reported `current` (an interrupt between the two renames leaves no `dist/`, which `verifyBuild` rejects outright); only Node-20 APIs are used (`performance.now`, `WeakMap`, `fs.rmSync`, `node:test`); paths are split/joined per segment so Windows is not broken; test output is pristine with no stray writes.

---

## Concerns for the controller / later tasks

1. **`verifyBuild` is a source-checkout predicate, not an installed-package one.** An installed tarball has `dist/` and `scripts/` but no `src/` and no `package-lock.json`, so `inputIdentity` there computes a different digest and `verifyBuild` returns `current:false`. That is honest (it genuinely cannot prove the binding without the source), but **Task R2 must not read that as "stale, rebuild"** — an installed package has no TypeScript to rebuild with. R2's bootstrap should gate the freshness check on `src/` being present.

2. **`dist/build-receipt.json` (≈51 kB) now ships in the tarball**, because `files` includes `"dist"`. It is benign — verified to contain no host paths, and `scripts/verify-tarball.mjs:64` filters to `.js`, so the tool-count derivation is unaffected. It is arguably a feature (a consumer can see exactly what produced the payload). Flagging it as a deliberate, reversible consequence rather than an oversight.

3. **`nodeMajor` participates in the identity**, so a `dist/` built on Node 20 reads as not-current on Node 22. CI builds and tests within one job, so no lane is affected; a developer switching Node versions will simply be told to rebuild, which is correct.

4. **`npm run test:tarball` was not run** — it does `npm install --omit=dev <tarball>` into a sandbox, which needs the network. I exercised the offline half of it (`npm pack --dry-run`, which runs the full `prepack` chain) and confirmed the `.js` filter at `verify-tarball.mjs:64` makes the new receipt invisible to the payload derivation. The networked half remains unverified.

5. Five gate failures (2 in `distribution-adoption`, 3 in `lint`) remain red in this worktree. They are pre-existing and proven so above; they are not in scope for this task.

---

# Fix round 1 — interrupted builds leave a lock that blocks every later build

**Commit:** `2fe9ea6` — `fix: recover interrupted source builds without stealing the lock` (not pushed)
**Finding:** Important — `scripts/build-source.mjs:104-114, 200-208`. Accepted as correct; reproduced before fixing.

## Reproducing it first

A real SIGINT against a real build on the real checkout, with the signal handler disarmed to stand in for the pre-fix code:

```
### CONTROL (pre-fix behaviour: no signal handler) ###
observed mid-build: .dist-staging-706c270b4956abfc, .pico-source-setup.lock
exit code: null  signal: SIGINT
scratch left in checkout: .dist-staging-706c270b4956abfc, .pico-source-setup.lock
dist present: true

### what a later build then hits ###
ERROR: another build is holding /Users/.../.pico-source-setup.lock (pid 84549, which is no longer
running); waited 30000ms. That build did not finish. Remove the stale lock: rm /Users/.../.pico-source-setup.lock
simulated wait: 30000ms
```

Exactly the reviewer's scenario: a leaked lock, a full staging copy of the emitted tree, both gitignored, and every later build burning 30 s before failing against a dead pid.

## What changed

**(a) Signal handlers, armed only while a lease is held.** `armInterruptCleanup()` registers `process.once("SIGINT"/"SIGTERM")` when a lock is taken and `disarmInterruptCleanup()` removes them once no lease remains, so the module never leaves listeners on a process that is not building. The exported `handleInterrupt(signal, {raise})` walks only this process's own lease records: it removes only that build's staging path (through `removeOwnedScratch`, so the same shape check applies) and calls `releaseLock`, which unlinks **only** when the on-disk ownership record still carries our token. It then calls `raise(signal)`, which by default removes our listeners and re-raises, so the signal takes its default course and npm sees an interruption rather than a clean exit.

To make that reachable, `ACTIVE_LEASES` became a `Map` from lease to `{checkout, lockPath, token, staging}` — a handler cannot iterate a `WeakMap`. The ownership check is now `ACTIVE_LEASES.get(owner)?.checkout !== checkout`; the lease object remains an opaque frozen token that exposes no root, so nothing about forgeability changed.

**(b) An under-lock sweep.** SIGKILL and power loss answer to no handler, so `buildSource` calls `sweepStaleScratch(checkout)` immediately after acquiring the lock and before creating its own staging. It removes `.dist-staging-*` / `.dist-backup-*` **directories** in the root — never a bare prefix, never a file, never anything outside the root, since `readdirSync(root)` is the only source of candidates and every removal still goes through `assertOwnedScratch`. This is safe precisely because holding the lock proves no other build owns scratch there. It logs what it recovered rather than deleting silently.

The sweep also closes a window the handler cannot: an interrupt *between* the two renames inside `publishStaging` leaves a `.dist-backup-*` that is not in the lease record. The next build clears it.

**(c) Dead pid: reported, never stolen.** The brief's never-steal rule stands — a waiter cannot know the file is not about to be rewritten — so `lockTimeoutError` only *reports*. `pidAlive()` uses `process.kill(pid, 0)`, mapping `ESRCH` to dead, `EPERM` to alive (it exists, it just is not ours) and anything else to unknown. A dead holder produces "(pid N, which is no longer running) … Remove the stale lock: rm <path>"; a live one keeps the original "remove the lock only if that process is gone" wording. The lock file is never touched on either path. The liveness check runs at the deadline, not at t=0, so the brief's full `waitMs` wait is unchanged.

## Covering tests (4 new, 22 total)

| Test | Proves |
| --- | --- |
| holding the lock sweeps scratch an interrupted build left, and nothing else | stale staging **and** backup are swept; a bare `.dist-staging-` prefix, a same-named *file*, `src/`, and a `.dist-staging-*` in another checkout all survive |
| the next build recovers scratch an interrupted build left behind | `buildSource` end-to-end: abandoned staging gone, `verifyBuild` current, no scratch left |
| an interrupt releases this build's lock and staging, then re-raises the signal | the handler alone cleans up, and the signal is re-raised |
| an interrupt never releases a lock that is no longer this build's | a lock taken over mid-build survives the handler **and** the exit path |
| a lock whose holder has exited is reported as dead, with a recovery command, not stolen | dead-pid wording + recovery command, lock still present; live-holder wording stays distinct |

The dead pid is real, not fabricated: `spawnSync(process.execPath, ["-e", ""])` and its now-exited pid. Tests stay hermetic and clock-injected — the 30 s deadline is exercised in microseconds.

### A vacuous test caught by mutation probing

The first version of the interrupt test asserted disk state *after* `buildSource` returned, so `buildSource`'s own `finally` had already cleaned up. Mutations M7 (handler does not remove staging) and M8 (handler does not release the lock) both passed — the test proved nothing, because a real Ctrl-C never reaches that `finally`. The tests now read the disk **inside the compiler callback, immediately after the handler runs**, which is precisely the state a killed process would leave. Re-probed:

| Mutation | Before the fix | After |
| --- | --- | --- |
| M7 handler leaves staging | (no failure) | ✖ 2 tests |
| M8 handler leaves lock | (no failure) | ✖ 1 test |
| M6 sweep disabled | ✖ 2 tests | — |
| M9 `releaseLock` drops the token check | ✖ 1 test | — |
| M10 dead-pid detection removed | ✖ 1 test | — |
| M11 signal swallowed, not re-raised | ✖ 1 test | — |

## Commands and output

```
$ node --test test/buildfreshness.mjs
✔ ... (22 tests)
ℹ tests 22   ℹ pass 22   ℹ fail 0

$ npm run build
build-source: published 182 file(s) for source b65f30ff49e0

$ node --test test/run-battery.mjs
ℹ tests 8   ℹ pass 8   ℹ fail 0

$ node test/docsmeta.mjs
Docs/metadata gate done. Failures: 0
```

**Real SIGINT against a real build, with the fix in place:**

```
observed mid-build: .dist-staging-706c270b4956abfc, .pico-source-setup.lock
exit code: null  signal: SIGINT
scratch left in checkout: (none)
dist present: true
```

**The full recovery loop, following the printed command after the control run's leak:**

```
$ rm /Users/.../.pico-source-setup.lock
lock removed; staging tree still present: .dist-staging-706c270b4956abfc
$ npm run build
build-source: recovered scratch from an interrupted build: .dist-staging-706c270b4956abfc
build-source: published 182 file(s) for source b65f30ff49e0
$ ls -a | grep dist-   ->  (no scratch left)
verifyBuild: {"current":true,"reasons":[]}
```

## Files changed

| File | Change |
| --- | --- |
| `scripts/build-source.mjs` | +137/-16 — lease records, `handleInterrupt`, `sweepStaleScratch`, `releaseLock`, `pidAlive`, `lockTimeoutError` |
| `test/buildfreshness.mjs` | +151 — 4 new tests, 22 total |

## Notes

- One deliberate stderr line appears in the suite (`build-source: recovered scratch from an interrupted build: …`). It is the behaviour under test, not stray output; silently deleting a directory someone might be inspecting would be worse.
- Minor review items were not addressed this round, as instructed.

---

# Fix round 2 — my sweep could delete a concurrently-live sibling's staging

**Commit:** `737398d` — `fix: keep live staging out of the stale-scratch sweep` (not pushed)
**Finding:** Important, and a genuine regression introduced by my round-1 fix. Accepted; reproduced before fixing.

## Reproducing it first

The docstring I wrote in round 1 claimed holding the lock "proves no other build owns scratch in this root right now". That is true of other *processes* and false of other builds in *this* process, because the `owner` reuse path is explicitly supported. PoC: two `buildSource` calls sharing one lease, the first parked inside its compiler.

```
$ node poc-concurrent.mjs                                    # against 2fe9ea6
build-source: recovered scratch from an interrupted build: .dist-staging-46910d5c78bd6b1c
A:start .dist-staging-46910d5c78bd6b1c
B:start .dist-staging-139f5aee011f432e
A:resume staging-exists=false
A:rejected B:fulfilled

A's staging survived its own await: false
```

B's sweep deleted A's in-use staging tree, logged the misleading recovery line, and A's build failed. Same code after the fix:

```
$ node poc-concurrent.mjs                                    # against 737398d
A:start .dist-staging-f96de24d2bc6d408
A:resume staging-exists=true
B:start .dist-staging-f25bd5061f23ad1c
A:fulfilled B:fulfilled

A's staging survived its own await: true
scratch left: (none)
```

## What changed

**(1) Same-lease builds are serialized.** Each lease record carries a `chain` promise; `serializeUnderLease` queues each `buildSource` behind the previous one and re-arms the chain with a swallowed continuation, so a failed build does not poison the queue behind it. A second concurrent same-lease call now waits rather than interleaving. Sequential and nested reuse are unaffected — they find an already-settled queue. The build body moved into `compileAndPublish(held, compile)` so the queued unit is one whole build.

**(2) Live scratch is tracked and skipped.** The record's single `staging` slot became `live: Set<string>`, holding every in-flight staging path and, through an optional third argument to `publishStaging`, the backup path during the swap. `sweepStaleScratch` consults `isLiveScratch(target)` across **all** active leases and skips anything recorded live. The interrupt handler now iterates the set and removes every recorded staging path (filtering on `STAGING_PREFIX`, so a backup — which holds the previous output — is never deleted by a signal), instead of reading one slot that whichever concurrent call assigned last would have clobbered.

The publication swap is synchronous, so a sibling cannot actually observe the backup mid-flight; it is tracked anyway so the invariant survives anyone making that path async later. The docstring now states both conditions instead of the one that was wrong.

## Covering tests (2 new, 24 total)

| Test | Proves |
| --- | --- |
| two concurrent builds under one lease are serialized, and neither sweeps the other | A's staging survives its own `await` with B queued; event order is `A:start A:end B:start B:end`; both publications complete; `dist` holds B's output; `verifyBuild` current; no scratch or lock left |
| the sweep spares staging an active build is using | a sweep called from inside a live build removes a planted stale sibling and **not** the tree the running build is using |

Both use the public API only, with a test-owned barrier and the existing hermetic fixtures.

### Probing the two defences separately

| Mutation | Result |
| --- | --- |
| M12 serialization removed, live set intact | ✖ concurrency test — on the event-order assertion (`the two builds interleaved`). **A's staging still survived**: the live set alone held the line. |
| M13 live-set skip removed, serialization intact | ✖ sweep test |
| M14 both removed (the reported bug) | ✖ both tests |

M12 is the useful one: it demonstrates empirically that the second defence is not decorative — with serialization gone, the live set still prevented the data loss, and only the ordering assertion failed.

### One test I wrote and then deleted

I drafted a third test for "an interrupt clears every in-flight staging tree a lease holds, not just the newest". Once same-lease builds are serialized, **two in-flight staging trees per lease are unreachable through the public API**, and the only way to write the test was a test-only accessor reaching into lease internals. I deleted it rather than ship coverage theater. The set-iteration in the handler remains as defense in depth and is exercised for the single-entry case by the existing interrupt test.

## Commands and output

```
$ node --test test/buildfreshness.mjs
ℹ tests 24   ℹ pass 24   ℹ fail 0

$ npm run build
build-source: published 182 file(s) for source b65f30ff49e0

$ node --test test/run-battery.mjs
ℹ tests 8   ℹ pass 8   ℹ fail 0

$ node sigint-probe.mjs          # round-1 behaviour still intact after the refactor
observed mid-build: .dist-staging-62eb908606c4526d, .pico-source-setup.lock
exit code: null  signal: SIGINT
scratch left in checkout: (none)
dist present: true

$ verifyBuild(cwd)  ->  {"current":true,"reasons":[]}
```

## Files changed

| File | Change |
| --- | --- |
| `scripts/build-source.mjs` | +133/-49 — `serializeUnderLease`, `compileAndPublish`, `live` set, `isLiveScratch`, handler iteration, `publishStaging(root, staging, live)` |
| `test/buildfreshness.mjs` | +77 — 2 new tests, 24 total |

## Note

One narrow window is unchanged and worth recording rather than fixing under this round's scope: if the staging→`dist` rename fails **and** the restore also fails, `publishStaging` keeps the backup and tells the user to rename it back by hand. If they run `npm run build` again first, the sweep removes it. Nothing of value is lost unless that rebuild also fails, since a successful rebuild replaces `dist` outright — but the message does not warn about the ordering.

Ledgered Minor items were not touched.

## Addendum — a NEW issue found while verifying round 2, and a correction to round-1 evidence

After committing round 2 I found a `.dist-staging-62eb908606c4526d` sitting in the checkout that the SIGINT probe had reported as `(none)` moments earlier. It held a **complete 182-file tsc output**.

**Cause.** `handleInterrupt` removes the staging directory but does not kill the compiler `runCompiler` spawned. When only the direct child is signalled, the orphaned `tsc` keeps running and **re-creates** the tree the handler just deleted.

**Correction to round 1.** My round-1 line "scratch left in checkout: (none)" was measured at the child's `close` event — true at that instant, but it read the disk before the orphaned compiler finished. The claim was premature, not false; the honest statement is that the handler's own cleanup completes, and a surviving compiler can undo it.

**Bounded by measurement, not assumption:**

| Signal delivery | Result |
| --- | --- |
| Process **group** SIGINT — what a terminal Ctrl-C actually does | no scratch left, re-checked 4 s after exit. The compiler dies with the group, so nothing is re-created. This is the common case. |
| SIGINT to the **direct child only** — a supervisor, CI runner or `child.kill()` | the orphaned compiler completes and re-creates the staging tree |
| Recovery in that case | self-heals: the next build's sweep removes it (it is live in no lease) and publishes normally — `build-source: recovered scratch from an interrupted build: .dist-staging-62eb908606c4526d`, then `verifyBuild {"current":true,"reasons":[]}` |

**Not fixed in this round, deliberately.** It is neither the round-2 finding nor a ledgered Minor, and the fix — tracking the spawned child and killing it in the handler — is an unrequested behavioural change to the signal path that deserves its own review rather than riding along in a commit scoped to the sweep. Flagging it for the controller to schedule. The leftover was cleaned up by running the next build; the checkout is clean and `verifyBuild` is current.

---

# Fix round 3 — stop the compiler child when a build is interrupted

**Commit:** `7f9a304` — `fix: stop the compiler child when a source build is interrupted` (not pushed)
**Finding:** the gap I reported in the round-2 addendum, ruled Important and in scope — incomplete cleanup inside the signal path this task introduced.

## What changed

**Cancellation is now part of the compiler contract.** `runCompiler({root, outDir, signal, ...})` accepts an `AbortSignal`, rejects immediately with a clear "the build was interrupted; the TypeScript compiler was stopped" if it is already aborted, and on abort stops its child before settling. `compileAndPublish` creates an `AbortController` per build and records it on the lease (`held.abort`, cleared in `finally`). `handleInterrupt` aborts **before** touching any staging path, so deletion happens only once the compiler can no longer write. `tscEntry` became injectable so a test can point at a stand-in without a real tsc. Fake compilers that ignore `signal` are unaffected — all 24 pre-existing tests passed without modification.

**Why stopping the child is synchronous.** The handler re-raises immediately afterwards, so an awaited exit would never get a turn on the event loop. Polling for the pid to disappear does not work either: a killed child stays a zombie until libuv reaps it, and libuv needs the very loop the handler is blocking. The guarantee therefore comes from the kernel rather than an observation — SIGTERM for a short courtesy grace (`Atomics.wait`, the same blocking-sleep idiom as `src/runlocks.ts`), then SIGKILL, which cannot be caught, blocked or ignored. Once it is delivered the compiler executes nothing further. That reasoning is in the code comment, because the next reader will otherwise "fix" it into a poll.

## Covering tests (2 new, 26 total)

| Test | Proves |
| --- | --- |
| an interrupt aborts the compiler before it removes the staging tree | the compiler is handed a live signal; at the instant the abort lands the staging tree is **still present**; after the handler it is gone. That ordering is the fix. |
| an interrupt stops the production compiler's child process | the real `runCompiler` with `tscEntry` pointed at a stand-in that announces its pid and rewrites `outDir` every 20ms; after the handler the pid is gone and no staging directory remains |

The stand-in removes the need for a real tsc and keeps the test at ~0.5s.

### Mutation probes

| Mutation | Result |
| --- | --- |
| M15 handler does not abort the compiler | ✖ both new tests |
| M16 abort fires but the child is not stopped | ✖ `compiler pid 7871 outlived the interrupt` (3.0s) |
| M17 staging deleted before the abort | ✖ the ordering test |

### A test defect the probes exposed

M15 did not fail — it **hung the runner for the full 600s timeout**, and I had to kill an orphaned fixture child by hand. Without the fix the compiler never exits, so `runCompiler`'s promise never settles, so `await assert.rejects(build, ...)` waited forever and even a `t.after` cleanup never ran. A regression that hangs CI is a far worse failure report than an assertion. The test now races the build against a 10s bound and asserts on the outcome string, and reaps its fixture child regardless of how it ends:

```
M15, before hardening:  ✖ ... (600207ms)   — runner hung, orphan killed by hand
M15, after hardening:   ✖ ... (10036ms)    — "the build never settled after the interrupt"
M16, after hardening:   ✖ ... (3040ms)     — "compiler pid 7871 outlived the interrupt"
```

## Re-checking the round-1 evidence line

Re-run with the new code, reading the disk only after the compiler is **confirmed dead** — the measurement my round-2 addendum flagged as premature:

```
observed mid-build: .dist-staging-cb0fd79b66a5360a, .pico-source-setup.lock
compiler processes mid-build: 1
build process: exit code null, signal SIGINT
compiler confirmed dead after 75ms
scratch left AFTER compiler death (+2s settle): (none)
dist present: true
```

This is the same harsh case that previously left a full 182-file staging tree: SIGINT to the **direct child only**, not the process group. The compiler now dies 75ms after the signal instead of running to completion, and the checkout is clean once it is gone — not merely at the moment the build process closed.

## Commands and output

```
$ node --test test/buildfreshness.mjs
ℹ tests 26   ℹ pass 26   ℹ fail 0

$ npm run build
build-source: published 182 file(s) for source b65f30ff49e0

$ node --test test/run-battery.mjs
ℹ tests 8   ℹ pass 8   ℹ fail 0

$ node test/docsmeta.mjs
Docs/metadata gate done. Failures: 0

$ verifyBuild(cwd)  ->  {"current":true,"reasons":[]}
checkout: no scratch, no stray fixture processes
```

## Files changed

| File | Change |
| --- | --- |
| `scripts/build-source.mjs` | +66/-10 — `signal` in the compiler contract, `stopChildSync`, `interruptedError`, injectable `tscEntry`, `held.abort`, abort-before-delete ordering |
| `test/buildfreshness.mjs` | +81 — 2 new tests, 26 total, plus the bounded-wait hardening |

## Housekeeping

Every mutation probe was restored from a byte-compared backup (`diff` clean, no `mutated` residue), and the orphaned fixture children created while probing were killed by matching only my own `pico-buildfresh-*/sleeper.mjs` command lines. No unrelated process was touched. The checkout ends clean with `verifyBuild` current.
