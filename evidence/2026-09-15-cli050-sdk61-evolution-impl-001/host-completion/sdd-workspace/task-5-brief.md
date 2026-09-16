### Task 5: Host-side correctness — receipt provenance and Node major, selected-tool toolchain watch, explicit perf device

**Files:**
- Modify: `scripts/build-identity.mjs:127-150` (`dependencyReceipt`, `writeDependencyReceipt`), `:240-292` (`receiptVerdict`, `verifyDependencies`)
- Modify: `scripts/plugin-bootstrap.mjs:266-300` (adoption message, fast path)
- Modify: `src/toolchainwatch.ts:18-30` (`installedVersions`)
- Modify: `src/doors.ts` `pico_perf` door (`:552-560`), `src/perfcli.ts:740-743` (description only)
- Test: `test/buildfreshness.mjs`, `test/plugin-bootstrap-freshness.mjs`, `test/toolchain-consumers.mjs`, `test/doors.mjs`, `test/picocli.mjs`

**Interfaces:**
- Produces: the dependency receipt gains `nodeMajor: number`; `verifyDependencies(root)` returns `{ current, acceptedBy, provenance: "npm-ci" | "hidden-lockfile" | null, identity, reasons }`; when a receipt exists and `receipt.nodeMajor !== nodeMajor()`, the hidden lockfile is NOT consulted and `reasons` names `installed under Node <a>, running Node <b>; reinstalling`; `acceptedBy` is `"receipt"` for either provenance (still receipt-fast) but `provenance` says which.
- Produces: `installedVersions(io?)` in `src/toolchainwatch.ts` reads `package.xml`/`version` from the SELECTED installation (`resolveHostToolchain({ required: ["emulator"] })`, `resolveHostToolchain({ required: ["editor"] })`) and returns `{ emulator, editor, sdkMaven, selection: { version, rootSource } | { unavailable: code } }`; the historical `0.13.3` references in comments/descriptions stay as provenance.
- Produces: `pico_perf` input `device: z.string().optional()` forwarded to `perf_diagnose`; result already carries `requestedDevice`; the door description says the target is the explicit `device` or the wrapper's documented default.

- [ ] **Step 1: Failing bootstrap tests** (append to `test/buildfreshness.mjs` or `test/plugin-bootstrap-freshness.mjs`, using their existing checkout fixture helpers)

```js
test("a receipt from another Node major blocks hidden-lockfile adoption and demands a reinstall", () => {
  const root = fixtureCheckout(t);                                       // existing helper
  writeDependencyReceipt(root, { identity: dependencyIdentity(root), npmArgv: ["ci"], source: "npm-ci" });
  const receiptPath = path.join(root, DEPENDENCY_RECEIPT_NAME);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, nodeMajor: receipt.nodeMajor - 1, dependencyIdentity: "0".repeat(64) }));
  writeMatchingHiddenLockfile(root);                                     // existing helper that makes matchesHiddenLockfile() true
  const verdict = verifyDependencies(root);
  assert.equal(verdict.current, false);
  assert.equal(verdict.acceptedBy, null);
  assert.match(verdict.reasons.join("\n"), /installed under Node \d+, running Node \d+/);
});

test("hidden-lockfile adoption records its provenance and never reports npm-ci", () => {
  const root = fixtureCheckout(t);
  writeMatchingHiddenLockfile(root);
  const first = verifyDependencies(root);
  assert.equal(first.acceptedBy, "hidden-lockfile");
  adoptInstalledDependencies(root, first);                              // export it from plugin-bootstrap.mjs for the test
  const second = verifyDependencies(root);
  assert.equal(second.acceptedBy, "receipt");
  assert.equal(second.provenance, "hidden-lockfile");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, DEPENDENCY_RECEIPT_NAME), "utf8")).nodeMajor, Number(process.versions.node.split(".")[0]));
});
```

- [ ] **Step 2: Run; expect FAIL. Implement in `scripts/build-identity.mjs`:** `dependencyReceipt` adds `nodeMajor: nodeMajor()`; `receiptVerdict` returns `{ current, reasons, nodeMajor: receipt.nodeMajor ?? null, source }`; `verifyDependencies`: after a non-current receipt, if `typeof receipt.nodeMajor === "number" && receipt.nodeMajor !== nodeMajor()` return `{ current: false, acceptedBy: null, provenance: null, identity, reasons: [...receipt.reasons, \`installed under Node ${receipt.nodeMajor}, running Node ${nodeMajor()}; the hidden lockfile cannot vouch for native or optional dependencies across majors, so this install is reinstalled\`] }` WITHOUT consulting `matchesHiddenLockfile`; otherwise as today, adding `provenance`. A receipt without `nodeMajor` (pre-this-change) is treated as `nodeMajor: null` → reinstall path reasons name it as unknown. In `scripts/plugin-bootstrap.mjs`, export `adoptInstalledDependencies` and make its stderr line read `accepted on npm's hidden lockfile (provenance recorded as hidden-lockfile; this bootstrap did not perform the install)`.

- [ ] **Step 3: Run `test:buildfreshness`, `test:plugin-bootstrap-freshness`; expect PASS. Commit.**

```bash
git commit -am "fix: dependency receipts carry Node major and provenance; hidden-lockfile adoption never crosses majors or claims npm-ci"
```

- [ ] **Step 4: Failing toolchainwatch test** (append to `test/toolchain-consumers.mjs`, in-memory io as the editor-palette case does)

```js
test("check_toolchain_updates reports the SELECTED installation's emulator and editor versions, never a hardcoded 0.13 path", async () => {
  const io = mixedHostIO({ versions: ["0.13", "6.1"], emulatorPackageXml: { "6.1": "<revision><major>6</major><minor>1</minor><micro>0</micro></revision>" }, editorVersion: { "6.1": "6.1.0" } });
  const versions = installedVersions(io);
  assert.equal(versions.emulator, "6.1.0");
  assert.equal(versions.editor, "6.1.0");
  assert.equal(versions.selection.version, "6.1");
  const source = fs.readFileSync(new URL("../src/toolchainwatch.ts", import.meta.url), "utf8");
  assert.ok(!/sdk\/0\.13\//.test(source.replace(/\/\/.*$/gm, "")), "no executed 0.13 path remains (comments documenting provenance may)");
});
```

- [ ] **Step 5: Run; expect FAIL. Implement `installedVersions(io = defaultToolchainIO())` on `resolveHostToolchain`; keep `out.sdkMaven = "6.0.0"` with its comment; keep the description's historical `0.13.3` provenance sentence. Run `test:sdkselection`; expect PASS. Commit.**

```bash
git commit -am "fix: check_toolchain_updates reads the selected toolchain, not a hardcoded 0.13 install"
```

- [ ] **Step 6: Perf door device pass-through** — in `test/doors.mjs` (call-lane fixture) assert `pico_perf { packageName, durationSec, device: "fixture-serial" }` forwards `device` to `perf_diagnose` and that omitting it forwards no `device` key; implement `device: z.string().optional().describe("adb serial to profile; forwarded verbatim. Omitted: the wrapper's documented default target.")` and forward. Update `perf_diagnose`'s description in `src/perfcli.ts:740` to say the wrapper reports `requestedDevice` in its result. Run `test:doors`, `test:picocli`; expect PASS. Commit.**

```bash
git commit -am "fix: pico_perf carries an explicit device through to perf_diagnose"
```

---

