### Task 3: Artifact preservation — no replacing rename, unique retained LOOK captures

**Files:**
- Modify: `scripts/publish-tarball.mjs:153-180` (`land`)
- Create: `src/capturepaths.ts`
- Modify: `src/capture.ts:16-19`, `src/eye.ts:313-322`, `src/emulatorlook.ts:92`
- Test: `test/publish-tarball.mjs:183-230`, `test/eye.mjs`, `test/verifyapk-observation.mjs:520-540` (source scan)

**Interfaces:**
- Produces: `export function observationCapturePath(kind: "capture-frame" | "canonical" | "emulator-look", fileName: string): string` in `src/capturepaths.ts` → `path.join(picoCliObservationRoot(), kind, <runId>, fileName)` where `runId = <ISO date without punctuation>-<uuid>`.
- Produces: `land()` throws `Error` with `code: "PUBLISH_NO_ATOMIC_PUBLICATION"` when `link()` fails with a `LINK_UNSUPPORTED` code; the staged temporary is removed by the existing `finally`.

- [ ] **Step 1: Flip the two fallback tests in `test/publish-tarball.mjs`**

```js
test("refuses to publish where hard links are unavailable instead of falling back to rename", (t) => {
  const { source, destination } = stage(t);                       // the file's existing staging helper
  const renames = [];
  const unsupported = () => { const error = new Error("cross-device link not permitted"); error.code = "EXDEV"; throw error; };
  assert.throws(
    () => publishTarball(source, destination, { io: { link: unsupported, rename: (from, to) => { renames.push([from, to]); } } }),
    (error) => error.code === "PUBLISH_NO_ATOMIC_PUBLICATION" && /hard link/i.test(error.message),
  );
  assert.deepEqual(renames, [], "no rename ever runs");
  assert.equal(fs.existsSync(destination), false, "nothing lands at the destination");
  assert.deepEqual(fs.readdirSync(path.dirname(destination)).filter((n) => n.includes(".publish-")), [], "the staged copy is removed");
});
```

Delete the "still refuses an occupied destination instead of overwriting it" rename test (the EEXIST-via-link test above it still covers occupancy). Keep the unlink-target assertion at `:296`.

- [ ] **Step 2: Run `node --test test/publish-tarball.mjs`; expect FAIL. Implement:**

```js
function land(temporaryPath, destinationPath, ops) {
  try {
    ops.link(temporaryPath, destinationPath);
  } catch (error) {
    if (error?.code === "EEXIST") throw occupiedError("the artifact", destinationPath);
    if (LINK_UNSUPPORTED.has(error?.code)) {
      const refusal = new Error(
        `cannot publish ${destinationPath}: this filesystem does not support hard links (${error.code}), and link() is the only atomic non-replacing publication primitive this script trusts. rename() would silently replace an existing artifact, so publication is refused. Publish onto a filesystem with hard-link support.`,
      );
      refusal.code = "PUBLISH_NO_ATOMIC_PUBLICATION";
      refusal.cause = error;
      throw refusal;
    }
    throw error;
  }
}
```

Remove `rename` and `openExclusive`'s probe use from `land` (keep `openExclusive` for the staged temporary). Update the header comment (steps 3–4) and TESTERS.md if it describes the fallback.

- [ ] **Step 3: Run `node --test test/publish-tarball.mjs` and `npm run --silent test:tarball`; expect PASS. Commit.**

```bash
git commit -am "fix: publication fails closed where atomic non-replacing linking is unavailable"
```

- [ ] **Step 4: Write the failing capture-path tests** — in `test/eye.mjs` (find the `capture_canonical` case) assert the returned/used `outPath` when omitted is under `picoCliObservationRoot()/canonical/<runId>/canonical.png`, is unique across two calls, and is never `/tmp/pico-render/canonical.png`; in `test/verifyapk-observation.mjs` extend the source-scan list at `:532` to `src/eye.ts` and `src/emulatorlook.ts` (no `/tmp/pico-render` literal). The default target `emulator-5554` stays: assert the fixture adb still receives `-s emulator-5554`.

- [ ] **Step 5: Implement `src/capturepaths.ts`, use it in `capture.ts` (delete its private `defaultCapturePath`), `eye.ts` and `emulatorlook.ts`; update the three descriptions ("Default: a run-unique retained file under the observation root; the default target is unchanged"). Rebuild, run `test:eye`, `test:observation`, `test:doors`, `test:tarball`; expect PASS. Commit.**

```bash
git commit -am "fix: canonical and emulator LOOK captures get run-unique retained paths"
```

---

