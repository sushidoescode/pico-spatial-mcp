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

