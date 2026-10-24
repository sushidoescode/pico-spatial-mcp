### Task 2: Rebuild changed source plugin caches without slowing unchanged startup

**Files:** Modify `scripts/plugin-bootstrap.mjs:34–45,193–220`, `scripts/build-source.mjs`, `test/distribution-adoption.mjs:854–875,960–1028`; add `test/plugin-bootstrap-freshness.mjs`.

**Interfaces:** Consume `verifyBuild(root)`, `withSourceSetup` and `buildSource` from Task 1. Replace boolean-only setup decisions with `sourceSetupPlan({dependenciesCurrent, buildCurrent}): string[][]`. Export `dependencyIdentity(root): string` from `build-identity.mjs`; it hashes the lockfile and Node major. Store successful source dependency-install identity in a local `.pico-dependencies.json` receipt; packaged artifacts do not require source files. A bootstrap installation and its resulting build share one setup lease.

- [ ] Extend bootstrap fixtures with initial success followed by a source edit, a lock edit, and a compiler failure. Preserve fake npm/child processes and hostile space/Unicode paths.
```js
assert.deepEqual(sourceSetupPlan({dependenciesCurrent:true, buildCurrent:false}), [['run','build']]);
assert.deepEqual(sourceSetupPlan({dependenciesCurrent:false, buildCurrent:false}),
  [['ci','--no-audit','--no-fund'], ['run','build']]);
```
- [ ] Run `node --test test/plugin-bootstrap-freshness.mjs`; confirm failure specifically at the absent freshness behavior.
- [ ] For source checkouts (`src/` plus `tsconfig.json` present), inspect receipts, acquire the setup lease if anything is stale, then re-read both dependency/build identities under that lease before choosing actions. Another owner may have completed setup during the bounded wait, in which case run neither install nor build. Keep the lease across `npm ci`, dependency-receipt publication, compilation and build publication. Recheck the lockfile identity after `npm ci`; reject changes during installation instead of recording misleading success. A cache without a trustworthy dependency receipt performs one bounded install rather than declaring unknown dependencies current.
```js
await withSourceSetup({root, waitMs:30_000}, async owner => {
  // Re-read identities here; install only if still stale and publish its receipt only after success.
  if (!verifyBuild(root).current) await buildSource({root, runCompiler, owner});
});
```
- [ ] Interpret the setup plan's build action as the in-process `buildSource({root,runCompiler,owner})` call while owning the lease, avoiding recursive `npm run build` lock acquisition. Supply `runCompiler` through the existing bounded child runner with the absolute installed TypeScript entry and explicit `outDir`. A standalone `npm run build` acquires its own lease. A failed prerequisite ends bootstrap; no MCP child launches with stale output.
- [ ] For source-less installed artifacts, verify emitted bytes using the build receipt without requiring source reconstruction; fail with reinstall guidance if payload validation fails. Do not attempt TypeScript compilation or repo-only dependency recovery for a tarball consumer.
- [ ] Keep npm chatter on stderr, preserve bounded command termination/signal propagation, and retain absolute child argv. Unchanged valid warm startup must make zero npm/build calls and must not resolve or provision a CLI package.
- [ ] Test deleted `dist`, changed source, changed lock, unknown dependency receipt, invalid packaged output, successful source-less payload, and failed compiler cases. Add two concurrent cold bootstraps and two concurrent changed-lock bootstraps against one temporary cache; delay fake `npm ci` and the compiler using test-owned barriers. Assert exactly one install and one build, no install overlaps any compiler, both successful callers observe the same output receipt, and a timed-out waiter launches no child. Test same-owner build reentrancy, wrong-root/retired lease rejection, and lockfile mutation during installation. Use injected clocks/barriers rather than sleeping 30 seconds.
- [ ] Run `npm run build`, `node --test test/plugin-bootstrap-freshness.mjs`, and focused bootstrap cases in `test/distribution-adoption.mjs`. Record cold/warm timings as observations, not promises about a host timeout.
- [ ] Add the dependency receipt to `.gitignore`; commit only these changes with `git commit -m "fix: refresh changed source plugin caches"`.

