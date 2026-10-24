### Task 1: Fixture isolation — pinned adb in every fixture gate, explicit harness override, every door through its seam

**Files:**
- Modify: `scripts/gate-inventory.mjs:36-51` (`FIXTURE_NO_ADB`, `gateChildEnv`)
- Modify: `scripts/run-gate.mjs:178` (call site; surface the refusal)
- Modify: `.github/workflows/gates.yml:11-17` (comment only; the env stays)
- Modify: `src/adb.ts:124-142` (`pick()`)
- Modify: `src/doors.ts:368-400` (`registerDoorTools`, `doorCall`, `doorCallRaw`) and the ten `const { call } = await inner();` sites at lines 472, 505, 547, 557, 573, 583, 637, 661, 781, 1016
- Modify: `AGENTS.md` gotcha paragraph "One inventory owns every gate command…" (the run-gate sentence)
- Test: `test/gate-inventory.mjs`, the adb resolution test file (`grep -ln 'override-rejected' test/*.mjs`), `test/doors.mjs`

**Interfaces:**
- Produces: `export const HARNESS_ADB_VARIABLE = "PICO_GATE_FIXTURE_ADB"` and `gateChildEnv(gate, env, io = { existsSync: fs.existsSync, isExecutable })` in `scripts/gate-inventory.mjs`; it returns a NEW env object for `fixture`/`installed-artifact` gates with `PICO_ADB` set to `FIXTURE_NO_ADB`, or to the validated harness override, and throws `Error` with `code: "GATE_FIXTURE_ADB_INVALID"` when the override is not an absolute path to an existing executable file. `native-contract` gates get `env` back unchanged.
- Produces: in `src/adb.ts`, a set-but-blank `PICO_ADB` yields `{ kind: "override-rejected", rejection: { path: "", reason: "is set but empty" } }` — the same fail-closed path a nonexistent file takes.
- Produces: in `src/doors.ts`, `registerDoorTools(server, dependencies?)` guarantees: when `dependencies` is an object (even `{}`), no door reaches `inner()`; `doorCall()` returns `dependencies.call` (or the domain lane derived from `callRaw`) and otherwise throws `Error("registerDoorTools was given a fixture without dependencies.call …")`; `doorCallRaw()` behaves the same for `callRaw`. T4 and T5 rely on every door using `const call = await doorCall();`.

- [ ] **Step 1: Write the failing gate-inventory tests** (append to `test/gate-inventory.mjs`, next to the existing `gateChildEnv` cases)

```js
import { gateChildEnv, FIXTURE_NO_ADB, HARNESS_ADB_VARIABLE, GATES } from "../scripts/gate-inventory.mjs";

test("an inherited real PICO_ADB is replaced by the fixture pin in fixture gates", () => {
  const env = { PATH: "/usr/bin", PICO_ADB: "/opt/homebrew/bin/adb" };
  const child = gateChildEnv(GATES["test:eye"], env);
  assert.equal(child.PICO_ADB, FIXTURE_NO_ADB);
  assert.equal(env.PICO_ADB, "/opt/homebrew/bin/adb", "the caller's env object is not written");
});

test("an empty or whitespace PICO_ADB is replaced, never passed through", () => {
  for (const value of ["", "   ", "\t"]) {
    assert.equal(gateChildEnv(GATES["test:eye"], { PICO_ADB: value }).PICO_ADB, FIXTURE_NO_ADB, JSON.stringify(value));
  }
});

test("installed-artifact gates are pinned exactly like fixture gates", () => {
  assert.equal(gateChildEnv(GATES["test:tarball"], { PICO_ADB: "/real/adb" }).PICO_ADB, FIXTURE_NO_ADB);
});

test("native-contract gates get the identical env object and no pin", () => {
  const env = { PATH: "/usr/bin", PICO_ADB: "/real/adb" };
  assert.equal(gateChildEnv(GATES["test:vcamtransport-native"], env), env);
});

test("the harness override passes an explicit fake executable through as PICO_ADB", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-fake-adb-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "adb");
  fs.writeFileSync(fake, "#!/bin/sh\nexit 66\n", { mode: 0o755 });
  const child = gateChildEnv(GATES["test:eye"], { PICO_ADB: "/real/adb", [HARNESS_ADB_VARIABLE]: fake });
  assert.equal(child.PICO_ADB, fake);
  assert.equal(child[HARNESS_ADB_VARIABLE], fake, "the override variable itself is kept so the child can see why");
});

test("an invalid harness override refuses to spawn the gate instead of falling back", () => {
  for (const bad of ["relative/adb", "/no/such/fake-adb", os.tmpdir()]) {
    assert.throws(() => gateChildEnv(GATES["test:eye"], { [HARNESS_ADB_VARIABLE]: bad }), (error) => error.code === "GATE_FIXTURE_ADB_INVALID", bad);
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `PICO_ADB=/fixture/no/such/adb node --test test/gate-inventory.mjs`
Expected: FAIL — `HARNESS_ADB_VARIABLE` is not exported; the inherited-value test sees `/opt/homebrew/bin/adb`.

- [ ] **Step 3: Implement `gateChildEnv`**

```js
// scripts/gate-inventory.mjs
import fs from "node:fs";
import path from "node:path";

export const FIXTURE_NO_ADB = "/fixture/no/such/adb";
/** The ONE way a fixture gate may see a working adb: the harness names a fake executable explicitly. */
export const HARNESS_ADB_VARIABLE = "PICO_GATE_FIXTURE_ADB";

function isExecutableFile(target) {
  try { fs.accessSync(target, fs.constants.X_OK); return fs.statSync(target).isFile(); } catch { return false; }
}

/**
 * The env a gate child is spawned with. Never mutates the env it is handed.
 * Fixture and installed-artifact gates ALWAYS get `PICO_ADB` pinned to a path that names no file —
 * an inherited value (real, empty or whitespace) is replaced, not trusted — unless the harness
 * explicitly names a fake executable in PICO_GATE_FIXTURE_ADB. `src/adb.ts` refuses an explicit adb
 * that is unusable, so a suite that still reaches adb fails loudly instead of touching a device.
 */
export function gateChildEnv(gate, env, io = { isExecutableFile }) {
  if (gate.scope === "native-contract") return env;
  const override = env[HARNESS_ADB_VARIABLE];
  if (override !== undefined) {
    if (typeof override !== "string" || !path.isAbsolute(override) || !io.isExecutableFile(override)) {
      const error = new Error(`${HARNESS_ADB_VARIABLE}=${JSON.stringify(override)} must be an absolute path to an existing executable fake adb; refusing to spawn ${gate.scope} gate children`);
      error.code = "GATE_FIXTURE_ADB_INVALID";
      throw error;
    }
    return { ...env, PICO_ADB: override };
  }
  return { ...env, PICO_ADB: FIXTURE_NO_ADB };
}
```

In `scripts/run-gate.mjs` the call `const childEnv = gateChildEnv(gate, env);` already exists; wrap it so a `GATE_FIXTURE_ADB_INVALID` error is printed with the fix ("unset PICO_GATE_FIXTURE_ADB or point it at an executable fake") and returns exit 2 before any spawn. Update the existing `gate-inventory.mjs` test that asserted "a caller-set value wins" to the new rule (caller-set values are replaced; only the harness variable passes through), and the `gates.yml` comment (the workflow env is now belt-and-braces for the raw step only).

- [ ] **Step 4: Run gate-inventory tests; expect PASS. Commit.**

```bash
git add scripts/gate-inventory.mjs scripts/run-gate.mjs .github/workflows/gates.yml test/gate-inventory.mjs
git commit -m "fix: pin PICO_ADB in every fixture gate regardless of inherited value; explicit harness override only"
```

- [ ] **Step 5: Write the failing adb test** (in the adb resolution test file)

```js
test("a set-but-blank PICO_ADB is an explicit override that fails closed", async () => {
  for (const value of ["", "  "]) {
    const io = fixtureAdbIO({ env: { PICO_ADB: value }, pathAdb: "/usr/local/bin/adb" }); // the file's existing fixture helper
    const result = resolveAdbForTest(io);                                                 // the file's existing entry point
    assert.equal(result.kind, "override-rejected", JSON.stringify(value));
    assert.match(result.rejection.reason, /set but empty/);
    assert.equal(io.probes.length, 0, "no PATH or bundled candidate is probed");
  }
});
```

(Use the helper and entry-point names the test file already defines; read it first. The invariant is: the PATH candidate must NOT be consulted.)

- [ ] **Step 6: Run; expect FAIL (today a blank value falls through to PATH). Implement in `src/adb.ts` `pick()`:**

```ts
const raw = io.env.PICO_ADB;
if (raw !== undefined) {
  const declared = raw.trim();
  if (declared === "") {
    return { kind: "override-rejected", rejection: { path: "", reason: "is set but empty — unset PICO_ADB to use the PATH/bundled chain, or name an absolute executable" } };
  }
  probed.push(declared);
  // … existing realpath / executable checks unchanged …
  return { kind: "winner", source: "explicit", path: declared };
}
```

Make sure the thrown message for the empty case still names `$PICO_ADB` (the existing throw formats `rejection.path`; an empty path must read as `$PICO_ADB="" is set but empty`).

- [ ] **Step 7: Run the adb tests and `test:sdkselection`; expect PASS. Commit.**

```bash
git commit -am "fix: a blank PICO_ADB is an explicit override and fails closed"
```

- [ ] **Step 8: Write the failing doors seam test** (append to `test/doors.mjs`, near the "partial injection (fix wave)" block)

```js
// Every door on a fixture server goes through the seam: with `{}` no door may reach inner().
{
  const bare = new McpServer({ name: "doors-bare-fixture", version: "0.0.0" });
  registerDoorTools(bare, {});
  const names = (await listToolNames(bare)); // use the file's existing helper for listing registered tools
  let reachedSeamError = 0;
  for (const name of names) {
    const result = await callTool(bare, name, minimalArgsFor(name)); // the file's existing call helper + a small map of valid minimal args
    const payload = JSON.parse(result.content[0].text);
    if (payload.status === "error" && /dependencies\.call|dependencies\.callRaw/.test(payload.error)) reachedSeamError++;
    else fail(`${name}: a door on a call-less fixture must refuse through the seam, got ${JSON.stringify(payload).slice(0, 200)}`);
  }
  expect("every door refuses through the seam on a {} fixture", reachedSeamError === names.length, `${reachedSeamError}/${names.length}`);

  // Source-level: the only inner() call sites left in doors.ts are the two lane fallbacks and innerCall().
  const source = fs.readFileSync(new URL("../src/doors.ts", import.meta.url), "utf8");
  const sites = source.match(/await inner\(\)/g) ?? [];
  expect("doors.ts has exactly three inner() sites (innerCall, doorCall, doorCallRaw)", sites.length === 3, `${sites.length}`);
}
```

- [ ] **Step 9: Run `test/doors.mjs`; expect FAIL (ten doors spawn or hang against the real inner). Kill nothing by hand — the pinned `PICO_ADB` makes the inner server's adb fail closed, but the test must not wait on it: give `callTool` a 10 s timeout in the helper if it lacks one.**

- [ ] **Step 10: Implement the seam rule in `src/doors.ts`**

```ts
export function registerDoorTools(server: McpServer, dependencies?: DoorToolDependencies) {
  const injected: Partial<InnerLanes> | null = dependencies
    ? (dependencies.callRaw ? lanesOf(dependencies.callRaw, async () => {}) : { call: dependencies.call })
    : null;
  const seamError = (lane: "call" | "callRaw") => new Error(
    `registerDoorTools was given a fixture (dependencies object) without dependencies.${lane}: doors never spawn the real inner full-surface server on a fixture, so this call is refused. Inject dependencies.${lane}.`,
  );
  const doorCall = async (): Promise<InnerLanes["call"]> => {
    if (injected) { if (injected.call) return injected.call; throw seamError("call"); }
    return (await inner()).call;
  };
  const doorCallRaw = async (): Promise<InnerLanes["callRaw"]> => {
    if (injected) { if (injected.callRaw) return injected.callRaw; throw seamError("callRaw"); }
    return (await inner()).callRaw;
  };
  // … then replace every `const { call } = await inner();` inside a door handler with `const call = await doorCall();`
```

- [ ] **Step 11: Run `test/doors.mjs` and `test:doors`; expect PASS. Update the AGENTS.md run-gate sentence to the new rule (inherited values replaced; `PICO_GATE_FIXTURE_ADB` is the only pass-through). Run `test:distribution-adoption`, `test:docsmeta`, `test:lint`. Commit.**

```bash
git commit -am "fix: every door reaches the inner server only through its dependency seam"
```

---

