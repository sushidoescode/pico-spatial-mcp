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

