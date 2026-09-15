# MCP Release Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CLI/SDK upgrade reproducibly buildable, testable, installable, and reviewable without stale JavaScript or overstated host verification.

**Architecture:** Bind compiled output to source and dependency identities, and make one explicit inventory own gate commands and host assignments. Preserve existing installed-tarball, policy, evidence, and stdio guards while separating hermetic contracts from live integration.

**Tech Stack:** Node.js 20/22, ESM JavaScript, TypeScript, node:test, npm lockfile v3, GitHub Actions.

**Spec:** [CLI 0.5.0 / SDK 6.1 evolution handoff](../../CLI_050_SDK61_EVOLUTION_HANDOFF_2026-09-15.md).

## Global Constraints

- Baseline: `308c898e9c33975b5a21ecb78fed245fab17a0ed`, `main`, package `37.0.0`; inspect actual HEAD and user changes before execution.
- Start the execution session with read-only `pico_doctor {}` and read `AGENTS.md`; use an isolated implementation worktree after reading the worktree skill.
- Mission Replay remains paused. Do not modify its checkout, run its builds, operate/restart/move/resize the emulator, change Wing, or kill unrelated processes.
- No global CLI installation, credential transfer, automatic CLI utility setup, or push. Preserve the six byte-pinned operational policy copies and offline startup behavior.
- Do not claim visual or actual-host verification from fixtures, help output, an exit-zero platform skip, or source inspection.
- Preserve old evidence and artifacts; use fresh identifiers. This plan was written without executing builds or tests.
- Comparator changes belong to the companion CLI compatibility plan; this plan only consumes its version-bound results.

## File Map and Sequencing

`scripts/build-identity.mjs` owns digests/receipts; `scripts/build-source.mjs` owns compilation and publication. `scripts/plugin-bootstrap.mjs` consumes those contracts for source caches. `scripts/gate-inventory.mjs` owns named gate definitions; `scripts/run-gate.mjs` owns freshness and execution; the battery remains an aggregator. `test/smoke.mjs` becomes hermetic and `test/sdk-integration.mjs` owns explicitly requested host integration. `scripts/public-docs.mjs` owns tracked-document selection; `scripts/publish-tarball.mjs` owns non-replacing publication. Existing metadata, tarball, distribution, and native tests remain authoritative within their measured scope.

Execute Tasks 1–3 sequentially. Tasks 4–6 can be reviewed independently once their gate entries are coordinated through Task 3. Task 7 consumes all accepted tasks. Do not let parallel workers edit the shared inventory/package/workflow files simultaneously.

### Task 1: Bind a clean successful build to its source

**Files:** Create `scripts/build-identity.mjs`, `scripts/build-source.mjs`, `test/buildfreshness.mjs`; modify `package.json:24–25`, `.gitignore`.

**Interfaces:** Export `inputIdentity(root): {schemaVersion:1, sha256:string, files:Array<{path:string,sha256:string}>}` and `verifyBuild(root): {current:boolean, reasons:string[]}` from `build-identity.mjs`. Export async `buildSource({root, runCompiler, owner?}): Promise<void>` and `withSourceSetup({root, owner?, waitMs, clock?}, work): Promise<void>` from `build-source.mjs`; `work(owner)` receives an opaque, active `SourceSetupOwner` lease scoped to the canonical root. Optional `clock` supplies `now(): number` and `wait(ms): Promise<void>` for deterministic deadline tests; production uses monotonic elapsed time. `runCompiler({root,outDir})` resolves only after successful compilation. Production compiler uses the checkout's installed TypeScript entry via `process.execPath`.

- [ ] Add source-only node:test fixtures using `fs.mkdtempSync`, a minimal `package.json`, lockfile, `tsconfig.json`, and `src/index.ts`. Import the proposed script modules directly so a missing export fails independently of stale `dist`.
```js
const before = inputIdentity(root).sha256;
fs.writeFileSync(path.join(root, 'src/index.ts'), 'export const value = 2;\n');
assert.notEqual(inputIdentity(root).sha256, before);
assert.equal(verifyBuild(root).current, false);
```
- [ ] Run `node --test test/buildfreshness.mjs`; retain the expected missing-module/export failure as the red result.
- [ ] Implement deterministic sorted relative-path hashes of `src/**/*.ts`, `tsconfig.json`, `package.json`, `package-lock.json`, installed TypeScript version, and Node major. Exclude timestamps/absolute host paths. Hash emitted relative paths and bytes into `dist/build-receipt.json`; exclude the receipt itself from its output digest.
```js
const material = files.map(({path, sha256}) => `${path}\0${sha256}\n`).join('');
const sha256 = crypto.createHash('sha256').update(material).digest('hex');
```
- [ ] Compile into a fresh sibling staging directory under `withSourceSetup`. Reserve `.pico-source-setup.lock` with exclusive creation; independent writers wait at most 30 seconds, then fail clearly without stealing the lock. Same-owner nested calls reuse only the exact active lease object for the same canonical root; caller-supplied strings, retired leases and other roots are rejected. After success, rename old `dist` to a unique backup and staging to `dist`; restore the backup if publication fails. Remove only task-owned staging/backup paths after success. Recheck input identity before publication and reject mid-build changes. Release the setup lock only if its ownership record still matches.
```js
await assert.rejects(buildSource({root, runCompiler: async () => { throw Error('compile failed'); }}));
assert.deepEqual(fs.readFileSync(oldEntry), oldBytes);
```
- [ ] Test source removal deletes its previously emitted module on the next successful build; source/lock edits invalidate receipts; failed compilation preserves old output; tampered/missing output invalidates receipts; concurrent writers cannot interleave. Ensure a failed or incomplete publication is never current.
- [ ] Change `build` to `node scripts/build-source.mjs`; retain prepack's bytecode cleanup followed by `npm run build`. Ignore only the newly specified lock/staging/backup artifacts. Run `npm run build`, then `node --test test/buildfreshness.mjs`.
- [ ] Review that no receipt leaks a home path and no cleanup crosses the checkout. Commit only the task files with `git commit -m "fix: bind clean build output to source identity"`.

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

### Task 3: Own gate commands and host assignments in one inventory

**Files:** Create `scripts/gate-inventory.mjs`, `scripts/run-gate.mjs`, `test/gate-inventory.mjs`; modify `package.json`, `scripts/run-battery.mjs`, `test/run-battery.mjs`, `test/buildrun-smoke-fixture.mjs:62–63`, `.github/workflows/gates.yml`, `test/distribution-adoption.mjs:1990–2017,2088–2098`, `README.md:312–323`, `AGENTS.md`.

**Interfaces:** `GATES` is `Record<string,{host:'linux'|'windows'|'macos', commands:string[][], scope:'fixture'|'native-contract'|'installed-artifact'}>`. Export `validateGateInventory(packageJson, workflow): string[]`. Export async `runGate(name,{root,env}): Promise<number>`; it consumes `verifyBuild(root)`, runs argv arrays sequentially without shell interpolation, and propagates a failing exit code.

- [ ] Populate `GATES` from every existing smoke/test command without dropping command tails joined by `&&`; add the new tests from Tasks 1–2 to existing appropriate fixture suites or deliberate new named entries. Assign `test:runrevision` to Linux. Keep native writer/reader on macOS and the shim lane on Windows.
```js
assert.deepEqual(validateGateInventory(packageJson, workflow), []);
const missing = workflow.replace('npm run test:runrevision', 'npm run build');
assert.match(validateGateInventory(packageJson, missing).join('\n'), /test:runrevision/);
```
- [ ] Run `node --test test/gate-inventory.mjs` and retain failures for missing, duplicate, unknown, and wrongly assigned gate invocations. Do not encode future numeric totals in these tests.
- [ ] Route each public named script through `node scripts/run-gate.mjs <name>`. Preserve the original argv and order in `GATES`; leave `build`, metadata commands, and explicit integration separate. Fail a source-dependent gate before any child runs if its build receipt is stale.
- [ ] In this same task, migrate `test/buildrun-smoke-fixture.mjs:62–63` from matching filenames inside the package script string to inspecting the exact resolved inventory command. Retain the Windows lane's assignment and all three constituent suites; a dispatcher string alone is not coverage.
```js
assert.equal(GATES['test:picocli-win'].host, 'windows');
assert.deepEqual(GATES['test:picocli-win'].commands, [[
  'node', '--test', 'test/picocli-autoinstall.mjs',
  'test/buildrun-smoke-fixture.mjs', 'test/run-battery.mjs',
]]);
```
```js
if (!verifyBuild(root).current) throw Error('Build output is stale; run npm run build first.');
for (const argv of GATES[name].commands) {
  const exit = await runArgv(argv, {root, env}); // local helper: shell:false, bounded, inherited stdio
  if (exit !== 0) return exit;
}
```
- [ ] Implement `runArgv(argv,{root,env}): Promise<number>` locally using `spawn(argv[0],argv.slice(1),{cwd:root,env,shell:false,stdio:'inherit'})`; timeout/child errors return nonzero and prevent later commands in that gate. Reuse current Windows launch handling where npm itself must be called.
- [ ] Derive battery commands and published inventory descriptions from `GATES`; assert exact set equality with package scripts and workflow assignments. Keep explicit platform tool-surface assertions separate from gate counts.
- [ ] Add mutation cases proving a source edit prevents all test children, and adding a script without a host assignment fails. Keep the battery's run-all-after-failure behavior; reserve new log files rather than replacing previous evidence.
- [ ] Run `npm run build`, `node --test test/gate-inventory.mjs test/buildrun-smoke-fixture.mjs`, `npm run test:runrevision`, `npm run test:lint`, and the inventory cases in distribution-adoption. Commit with `git commit -m "fix: make gate inventory complete and source-bound"`.

### Task 4: Make default smoke hermetic and host integration explicit

**Files:** Modify `test/smoke.mjs`, `test/helpers/buildrun-smoke-fixture.mjs`, `test/buildrun-smoke-fixture.mjs`, `.github/workflows/gates.yml:49–52`, `README.md:312–323`; create `test/sdk-integration.mjs`, `test/smoke-isolation.mjs`; coordinate `GATES` edits with Task 3.

**Interfaces:** Export `parseIntegrationArgs(argv): {projectDir:string,bundlePath:string,outputDir:string}` from `test/sdk-integration.mjs`. Its CLI requires all three absolute, explicit paths; output must be a new task directory. Default `smoke` never selects integration by detecting a locally installed SDK.

- [ ] Add a fixture invocation log to the fake Gradle/adb programs and a fake npm that rejects calls. Exercise smoke with fake binaries and verify only documented fixture operations occur; fail if any real project/package/device is targeted.
```js
assert.throws(() => parseIntegrationArgs([]), /--project.*--bundle.*--output/);
assert.ok(calls.every(call => call.serial === 'fixture-serial' || call.kind === 'fixture-gradle'));
assert.equal(npmCalls.length, 0);
```
- [ ] Run `node --test test/smoke-isolation.mjs` and preserve the expected current Claimsight/host-probe failure.
- [ ] Remove Claimsight constants, `SMOKE_SDK_OPTIONAL`, and the error-text skip regex from default smoke. Keep registration/output-schema/pure-tool checks and the existing fake build success path. Move `validate_toolchain`, `emulator_list`, real bundle pack/inspect, and SDK/proto discovery into explicit integration.
- [ ] Keep the default server invocation under explicit fixture SDK/CLI settings; use the existing fake `PICO_HOME` and fixture serial pattern. Assert startup and pure-tool checks make no registry/npm/setup/device calls. Do not repurpose the user's home variables or alter their CLI policy.
```js
const args = parseIntegrationArgs(process.argv.slice(2));
for (const input of [args.projectDir, args.bundlePath]) fs.accessSync(input, fs.constants.R_OK);
fs.mkdirSync(args.outputDir); // no recursive replacement; EEXIST preserves prior evidence
```
- [ ] Integration must check prerequisites before invocation and return explicit pass/fail/skipped records with reasons. A supplied malformed project, tool crash, schema mismatch, or unsuccessful pack is a failure; absence of optional tooling is a labeled skip, never success evidence.
- [ ] Remove CI's `SMOKE_SDK_OPTIONAL` escape hatch. Run `npm run build`, `node --test test/smoke-isolation.mjs`, `npm run smoke`, and the existing fixture suite. Default smoke must behave identically whether a host SDK/Claimsight checkout exists.
- [ ] Document the explicit integration command and its mutations; do not execute it against paused Mission Replay. Commit with `git commit -m "test: isolate smoke from personal SDK projects"`.

### Task 5: Check public documentation deterministically

**Files:** Create `scripts/public-docs.mjs`, `test/public-docs.mjs`; modify `test/docsmeta.mjs:56–80`, the docs gate entry, and only affected public-doc links.

**Interfaces:** Export `publicMarkdownFiles({root,trackedPaths}): string[]`; callers supply `git ls-files -z` results. Export `relativeLinkFailures({root,files}): Array<{file:string,target:string,reason:string}>`. An optional `--local` mode may audit extra local notes separately but must not silently change public gate scope.

- [ ] Add fixtures with tracked root/docs Markdown, ignored local notes, a tracked broken link, percent-encoded relative paths, and a symlink leaving the checkout.
```js
assert.deepEqual(publicMarkdownFiles({root,trackedPaths:['README.md','docs/a.md','src/a.ts']}),
  ['README.md','docs/a.md']);
assert.equal(relativeLinkFailures({root,files:['docs/a.md']})[0].target, 'missing.md');
```
- [ ] Run `node --test test/public-docs.mjs`; confirm failure is missing selection/parser behavior.
- [ ] Select tracked root `*.md` and tracked `docs/**/*.md` deterministically, including newly added/staged plan and handoff docs. Decode relative targets, validate they remain inside the checkout, and preserve rejection of missing targets. Keep HTTP/mail/fragment-only references excluded. Preserve existing code-block stripping and version/manifest checks.
```js
return trackedPaths.filter(p => p.endsWith('.md') && (!p.includes('/') || p.startsWith('docs/'))).sort();
```
- [ ] Verify untracked/ignored root notes cannot change the default result; malformed or escaping tracked links still fail. On source-less tarballs, use a packaged explicit document inventory if that mode is invoked; do not pretend Git metadata exists.
- [ ] Run `npm run build`, `node --test test/public-docs.mjs`, and `npm run test:docsmeta` after staging intended new docs. Repeat the docs test from a clean temporary checkout only to establish local/clean-checkout parity for this change.
- [ ] Commit with `git commit -m "test: make public documentation checks reproducible"`.

### Task 6: Publish only verified artifacts without deleting earlier versions

**Files:** Create `scripts/publish-tarball.mjs`, `test/publish-tarball.mjs`; modify `scripts/verify-tarball.mjs:35–36,407–418`, the tarball/inventory fixtures, and `TESTERS.md` publication guidance.

**Interfaces:** Export `publishVerifiedTarball({source,destination,expectedSha256}): {path:string,sha256:string,bytes:number}`. The caller supplies the exact tarball that passed installed-copy checks and its digest. Destination is an explicit final file path, not a directory to prune.

- [ ] Add tests with two previous versioned archives and a fresh output path; retain exact sentinel bytes after publication. Test destination collision, source digest mismatch, and interrupted copy.
```js
assert.throws(() => publishVerifiedTarball({source,destination:existing,expectedSha256}), /exists/);
assert.deepEqual(fs.readFileSync(existing), priorBytes);
assert.deepEqual(fs.readdirSync(archiveDir).sort(), priorNames);
```
- [ ] Run `node --test test/publish-tarball.mjs`; retain the absent-module red result.
- [ ] Verify the source digest, create a temporary file in the destination directory with exclusive mode, copy/fsync/recheck its bytes, then publish with an exclusive hard link or equivalent non-replacing primitive. Remove only the task-owned temporary file in `finally`; never enumerate/delete other archives.
```js
fs.linkSync(temporary, destination); // EEXIST leaves the existing artifact untouched
fs.unlinkSync(temporary);
```
- [ ] Replace `verify-tarball`'s prune/copy branch with this helper after all existing checks pass. Write a separate receipt containing artifact digest, bytes, source/build identity, platform, commands, pass/skip classifications, and limitations. Refuse any receipt destination collision.
- [ ] Preserve clean install, hostile paths, exact tool counts, schema/payload canaries, leak scans, and doors self-client round-trip. Source/build identity should correspond to the packaged output from Task 1, not a later checkout state.
- [ ] Run `npm run build`, `node --test test/publish-tarball.mjs`, `npm run test:tarball`; then exercise `--publish` into a fresh versioned evidence directory. Confirm previous archives remain byte-identical. Commit with `git commit -m "fix: preserve prior verified release artifacts"`.

### Task 7: Align release metadata and record honest platform acceptance

**Files:** Modify `package.json`, `package-lock.json`, `scripts/sync-metadata.mjs`, `test/docsmeta.mjs`, version-bearing `plugin.json`, `.claude-plugin/*`, `.codex-plugin/plugin.json`, `.cursor-plugin/*`, `.agents/plugins/marketplace.json`, `.github/plugin/marketplace.json`; write fresh release evidence and update affected public docs.

**Interfaces:** Extend existing docsmeta checks to compare `package-lock.json.version` and `package-lock.json.packages[''].version` to `package.json.version`. Consume Task 6's artifact receipt and the companion CLI plan's exact 0.4.4/0.5.0 compatibility receipts; do not infer semantic compatibility from help alone.

- [ ] Add a lock-version mismatch fixture without changing production version yet. Preserve each host's distinct manifest schema and exact launch-token contracts.
```js
for (const value of [lock.version, lock.packages[''].version]) assert.equal(value, pkg.version);
```
- [ ] Run the focused metadata test and retain a deliberate mismatch failure; restore the fixture, not production metadata.
- [ ] Choose the release version from accepted scope and repository compatibility policy, then set the task-specific `PICO_MCP_RELEASE_VERSION` environment value to that exact reviewed version. Apply it without creating a Git tag using the following guarded command; run `npm run sync:meta` and inspect the entire manifest/lock/doc diff before building.
```sh
node --input-type=module <<'NODE'
import { spawnSync } from 'node:child_process';
import { npmLaunch } from './scripts/plugin-bootstrap.mjs';
const version = process.env.PICO_MCP_RELEASE_VERSION;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version ?? ''))
  throw Error('PICO_MCP_RELEASE_VERSION must contain the reviewed release version');
const launch = npmLaunch(['version','--no-git-tag-version',version]);
const result = spawnSync(launch.command,launch.args,{stdio:'inherit'});
process.exit(result.status ?? 1);
NODE
```
- [ ] Run `npm run build`, `node scripts/sync-metadata.mjs --check`, `npm run test:docsmeta`, `npm run test:distribution-adoption`, and the now-hermetic inventory-driven battery with a fresh log path. Do not re-run completed expensive checks without source changes or unresolved failures.
- [ ] Produce the exact distributable through Task 6. Verify installed `tools/list` and representative door/full requests on each actually exercised platform. Record fixture-only Windows coverage and macOS compile/contract coverage separately when installed-host execution is unavailable.
- [ ] Actual Claude/Codex/Cursor discovery remains a separate host acceptance step: record host/version, plugin/source identity, expanded command, startup result, and observed tool requests. Test-side token replacement alone earns structural coverage. No emulator/physical/headset claim is part of this plan.
- [ ] Update AGENTS' stale historical test counts from the derived inventory without changing canonical policy bytes. If any policy change is independently approved by scope, update its canonical assertion and all six documents together; do not bypass its guard.
- [ ] Publish no remote release and push nothing. Commit the coherent local metadata/evidence checkpoint with `git commit -m "chore: checkpoint validated CLI SDK compatibility release"` after reviewing explicitly staged paths.

## Completion and Review Checklist

- [ ] Source/lock edits cannot serve or test stale output; removed source cannot ship orphan JS; failed builds preserve prior usable artifacts.
- [ ] Every named gate has one declared host assignment; revision suites execute; new scripts cannot silently escape CI.
- [ ] Default smoke needs no personal project and reaches no real device/CLI acquisition path; optional integration reports limits explicitly.
- [ ] Tracked docs have the same default result locally and in a clean checkout; package, lock, and host manifests carry one release identity.
- [ ] Verified publication never replaces/deletes prior artifacts; installed-artifact checks and actual-host checks are separately evidenced.
- [ ] No global CLI, paused app, emulator, Wing, credentials, policy guard, history, or remote state was changed outside authorized scope.
