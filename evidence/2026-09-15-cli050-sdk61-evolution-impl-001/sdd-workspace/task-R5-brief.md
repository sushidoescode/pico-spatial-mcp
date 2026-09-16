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

