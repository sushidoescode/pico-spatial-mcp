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

