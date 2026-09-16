# CLI 0.5 / SDK 6.1 Host-Only Completion Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the fixture-isolation, determinism, artifact-preservation, log-clearing and host-correctness gaps the 38.0.0 checkpoint disclosed, then re-verify the branch with an independent review, a full battery and a fresh distributable and checkpoint — host-only, no emulator, no device, no merge, no push.

**Architecture:** Six tasks on the existing integration branch `cli050-sdk61-evolution-2026-09-15` (worktree `.worktrees/cli050-sdk61-evolution-2026-09-15`, base `dfb3f2d`). T1 (isolation) lands alone first. T2 and T3 touch disjoint files and may run in parallel worktrees. T4 and T5 both edit `src/doors.ts` and `src/adb.ts` after T1 and run sequentially on the integration worktree. T6 is the verification/release task. Every test run is spawned through `scripts/run-gate.mjs` (which pins `PICO_ADB`) or with `PICO_ADB=/fixture/no/such/adb` exported; no test may reach a device.

**Tech Stack:** TypeScript (Node ESM, MCP SDK, Zod) in `src/`, Node test runner (`node --test`) and plain `node test/*.mjs` suites importing `../dist`, `scripts/*.mjs` release tooling, GitHub Actions `gates.yml`.

**Spec:** `docs/superpowers/specs/2026-09-16-cli050-host-completion-spec.md`

## Global Constraints

- Root alone owns `emulator-5554`. Never restart, move or resize the emulator; never touch a physical device; never calibrate; no emulator sign-in; no Chrome credentials; no Mission Replay work (`/Users/sushantsrikrish/AndroidStudioProjects/rocketsim-mission-replay` is off limits).
- No push, no history rewrite, no bare `git stash`, no merge to `main`. Work only in the named worktrees.
- `npm run build` before any test that imports `../dist` (70 of 97 test files do; `run-gate` refuses a stale `dist/`).
- Every direct test invocation exports `PICO_ADB=/fixture/no/such/adb`. Gate runs go through `npm run --silent <gate>` (run-gate pins the child).
- Preserve committed evidence bytes: never modify or delete anything under `evidence/`; new logs go under `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/host-completion/` (fresh) and the new distributable under `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/host-completion/`.
- Preserve the incident records in `docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md` verbatim.
- Preserve historical SDK references (`0.13.3` provenance in comments, descriptions and `docs/SDK_6_0_0_DRIFT.md`) where they document provenance.
- The byte-pinned managed pico-cli policy block and its vocabulary rule (`test/distribution-adoption.mjs`) are untouched; read that test's pattern list before writing prose in README/AGENTS/TESTERS/SKILLS/GETTING_STARTED/docs/HOSTS/CHANGELOG.
- Version stays 38.0.0 (never released); the new artifact is distinguished by its receipt identities and directory.
- No "red by ruling": every gate in the final battery must be green on this host.
- Never claim native, visual, device, cross-platform or end-to-end evidence; label everything fixture / source-derived / host-executed.
- Every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| Task | Creates | Modifies | Tests |
|---|---|---|---|
| T1 | — | `scripts/gate-inventory.mjs`, `scripts/run-gate.mjs`, `.github/workflows/gates.yml`, `src/adb.ts`, `src/doors.ts`, `AGENTS.md` | `test/gate-inventory.mjs`, the adb resolution tests (find with `grep -ln 'override-rejected' test/*.mjs`), `test/doors.mjs` |
| T2 | `test/fixtures/claims/expected-manifest.json` | `test/claimspage.mjs`, `test/fixtures/runlock-child.mjs`, `test/runrevision-locks.mjs` | same files |
| T3 | `src/capturepaths.ts` | `scripts/publish-tarball.mjs`, `src/capture.ts`, `src/eye.ts`, `src/emulatorlook.ts` | `test/publish-tarball.mjs`, `test/eye.mjs`, `test/verifyapk-observation.mjs` (source scan) |
| T4 | `src/logwindow.ts`, `test/logwindow.mjs` | `src/adb.ts`, `src/agentloop.ts`, `src/assertscene.ts`, `src/sense.ts`, `src/copilot.ts`, `src/workflow.ts`, `src/doors.ts`, `src/boundaryexperiment.ts` | `test/logwindow.mjs`, `test/doors.mjs`, `test/boundaryexperiment.mjs`, `test/preflight.mjs` or the suites that fixture these tools |
| T5 | — | `scripts/build-identity.mjs`, `scripts/plugin-bootstrap.mjs`, `src/toolchainwatch.ts`, `src/doors.ts`, `src/perfcli.ts` | `test/plugin-bootstrap-freshness.mjs`, `test/buildfreshness.mjs`, `test/toolchain-consumers.mjs`, `test/doors.mjs`, `test/picocli.mjs` |
| T6 | `docs/findings/CLI050_HOST_COMPLETION_CHECKPOINT.md`, `evidence/…/release/host-completion/*` | `CHANGELOG.md`, `docs/findings/CLI050_CAPABILITY_MATRIX.md`, `AGENTS.md` (if behavior text changed) | full battery |

---

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

### Task 2: Deterministic gates — a fixture ledger for test:claims and a controlled clock for the revision-lock capacity test

**Files:**
- Create: `test/fixtures/claims/expected-manifest.json`
- Modify: `test/claimspage.mjs:185-212`
- Modify: `test/fixtures/runlock-child.mjs:241` (the `monotonicMs` dependency)
- Modify: `test/runrevision-locks.mjs:488-530` (`spawnCapacityChild`) and the test at `:2625`
- Test: same files (`test:claims`, `test:runrevision`)

**Interfaces:**
- Consumes: `buildClaimsManifest`, `renderClaimsHtml` from `dist/claimspage.js`; `appendLedgerEntry`, `appendAutoJudgedEntry`, `materializeCapture` from `dist/ledger.js`; `PICO_MCP_LEDGER_DIR` (read by `ledgerDirectory()` at call time).
- Produces: env `PICO_CLAIMS_LIVE_LEDGER=1` opts INTO the machine-specific live-ledger comparison (default: skipped with a printed line); env `PICO_RUNLOCK_CHILD_CLOCK_SCALE=<factor>` slows the child's monotonic clock (test-only dependency injection; production constants untouched).

- [ ] **Step 1: Write the fixture-ledger section** (replace lines 185-212 of `test/claimspage.mjs`)

```js
// 2) a FIXTURE ledger, built with the real writer API from deterministic inputs, so this gate has the
//    same answer on every host. The manifest never carries timestamps (only seq/claim/evidence/capture
//    identities), so the committed expected manifest is exact.
const fixtureLedgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "claims-fixture-ledger-"));
const priorDir = process.env.PICO_MCP_LEDGER_DIR;
process.env.PICO_MCP_LEDGER_DIR = fixtureLedgerDir;
try {
  const golden = path.resolve("golden/showcase-6cards.golden.png");
  appendLedgerEntry("com.fixture.alpha", { claim: "alpha renders six cards", evidenceType: "vision_verified", attestation: "looked at the golden frame", artifactPath: golden });
  appendLedgerEntry("com.fixture.alpha", { claim: "alpha compiles", evidenceType: "compiles" });
  appendAutoJudgedEntry("com.fixture.beta", { claim: "beta panel centered", artifactPath: golden, score: 0.91 });
  // (use the exact writer signatures from dist/ledger.js — read them; include one entry of every class
  //  the manifest distinguishes, and one retraction via appendLedgerRetraction so withdrawn rows are exercised)
  const manifest = buildClaimsManifest({});
  const expectedPath = path.resolve("test/fixtures/claims/expected-manifest.json");
  if (process.argv.includes("--update-fixture")) fs.writeFileSync(expectedPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  if (JSON.stringify(manifest) === JSON.stringify(expected)) ok("fixture ledger generates the committed expected manifest byte-for-byte");
  else fail(`fixture manifest drifted from test/fixtures/claims/expected-manifest.json (re-run with --update-fixture ONLY after reviewing the diff)`);
  const strong = buildClaimsManifest({ minEvidence: "auto_judged" });
  const weakLeaked = Object.keys(strong.totals).some((t) => ["usd_host_render", "logcat", "structural", "compiles", "built_for_headset"].includes(t));
  if (!weakLeaked) ok("minEvidence=auto_judged drops weaker classes on the fixture ledger"); else fail("minEvidence filter leaked weaker evidence classes");
  const html = renderClaimsHtml(manifest, "2026-09-16T00:00:00.000Z");
  if (html.includes(manifest.apps[0].claims[0].capture.sha256)) ok("fixture HTML surfaces the capture hash verbatim"); else fail("fixture HTML lost the capture hash");
} finally {
  if (priorDir === undefined) delete process.env.PICO_MCP_LEDGER_DIR; else process.env.PICO_MCP_LEDGER_DIR = priorDir;
  fs.rmSync(fixtureLedgerDir, { recursive: true, force: true });
}

// 3) the machine-specific comparison against the maintainer's REAL ledgers is opt-in: it is host state,
//    not a property of the source, and regenerating the snapshot is a publication decision.
if (process.env.PICO_CLAIMS_LIVE_LEDGER === "1") {
  // … the previous block (lines 186-207) moves here unchanged …
} else {
  console.log("  skip live-ledger comparison (set PICO_CLAIMS_LIVE_LEDGER=1 on the ledger-owning machine to run it)");
}
```

Keep sections 1) and the tracked-snapshot consistency checks (lines 150-183: CAPABILITIES.md totals, HTML generated from JSON, withdrawn rows) exactly as they are.

- [ ] **Step 2: Run `PICO_ADB=/fixture/no/such/adb node test/claimspage.mjs --update-fixture` once to write the expected manifest, READ the JSON (no host paths, no timestamps, deterministic hashes), then run without the flag; expect PASS on a second run. Run `npm run --silent test:claims`; expect exit 0.**

- [ ] **Step 3: Commit.**

```bash
git add test/claimspage.mjs test/fixtures/claims/expected-manifest.json
git commit -m "test: give test:claims a deterministic fixture ledger; live-ledger comparison is opt-in"
```

- [ ] **Step 4: Slow the child clock in the capacity test** — in `test/fixtures/runlock-child.mjs` replace `monotonicMs: () => performance.now(),` with

```js
// A test-only clock. The production acquisition budget (ACQUIRE_BUDGET_MS in src/runlocks.ts) is not
// changed; the capacity tests scale the child's monotonic clock so a 15 s budget cannot expire inside a
// 16–18 s concurrent enrollment on a loaded host. Default scale 1 = wall clock.
const clockScale = Number(process.env.PICO_RUNLOCK_CHILD_CLOCK_SCALE ?? "1");
const clockOrigin = performance.now();
monotonicMs: () => clockOrigin + (performance.now() - clockOrigin) * (Number.isFinite(clockScale) && clockScale > 0 ? clockScale : 1),
```

and in `spawnCapacityChild` pass `env: { ...process.env, PICO_RUNLOCK_CHILD_CLOCK_SCALE: "0.01" }` to `fork`. Do NOT change `results.every(status === "acquired" || status === "limit-exceeded")` or the `<= 1 acquired` and exact-count assertions.

- [ ] **Step 5: Run `npm run --silent test:runrevision` three times in a row (log each); expect 327/327 each time. Commit.**

```bash
git commit -am "test: control the revision-lock capacity children's clock instead of racing the production budget"
```

---

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

### Task 4: Bounded, correlated log observation — no implicit global logcat clear anywhere

**Files:**
- Create: `src/logwindow.ts`, `test/logwindow.mjs`
- Modify: `src/assertscene.ts:71-80`, `src/sense.ts:571-584`, `src/copilot.ts:64-66`, `src/workflow.ts:380-384`, `src/doors.ts:1012-1016` (`pico_loop`), `src/adb.ts:330-342` (`logcat clear`), `src/adb.ts:396-440` (`assert_logcat`), `src/agentloop.ts:140-160` (`wait_for_log`), `src/boundaryexperiment.ts:3004-3016`
- Test: `test/logwindow.mjs` (new, registered under `test:emulator-restart`'s command list or a new gate — see T6), `test/doors.mjs`, `test/boundaryexperiment.mjs`, plus whatever suites fixture `assert_scene`/`probe_planes`/`build_and_run` (`grep -ln 'assert_scene\|probe_planes\|build_and_run' test/*.mjs`)

**Interfaces:**
- Produces (`src/logwindow.ts`):

```ts
export const LOG_WINDOW_TAG = "pico-mcp";
export interface LogWindow { serial: string; marker: string; openedAt: string }
export type AdbRunner = (args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;
/** Writes one marker line into the device's main log buffer (`adb -s S shell log -t pico-mcp <marker>`). Never clears anything. */
export async function openLogWindow(run: AdbRunner, serial: string): Promise<LogWindow>;
/** Bounded dump (`logcat -d -v threadtime -t <maxLines>` plus tag filters that always include pico-mcp:V), sliced to the lines AFTER the marker. */
export async function readLogWindow(run: AdbRunner, window: LogWindow, opts?: { tags?: string[]; buffers?: string[]; maxLines?: number; timeoutMs?: number }): Promise<{ markerSeen: boolean; lines: string[]; raw: string }>;
export function sliceAfterMarker(stdout: string, marker: string): { markerSeen: boolean; lines: string[] };
export function newLogMarker(): string; // `pico-mcp-window-<uuid>`
```

- Semantics every caller follows: a read with `markerSeen: false` (marker evicted or never written) is INCONCLUSIVE — the caller reports `{ logWindow: { marker, markerSeen: false }, status: "inconclusive" }` and never matches against the unscoped buffer. Every result carries `serial` (the explicit target context) and `logWindow`.

- [ ] **Step 1: Write `test/logwindow.mjs`** (pure unit tests, no adb)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { sliceAfterMarker, openLogWindow, readLogWindow, LOG_WINDOW_TAG } from "../dist/logwindow.js";

test("sliceAfterMarker returns only lines after the marker line", () => {
  const out = ["old 1", "old 2", `09-16 00:00:00.000  1  1 I ${LOG_WINDOW_TAG}: pico-mcp-window-abc`, "new 1", "new 2"].join("\n");
  assert.deepEqual(sliceAfterMarker(out, "pico-mcp-window-abc"), { markerSeen: true, lines: ["new 1", "new 2"] });
});

test("a missing marker is reported, never silently treated as an empty window", () => {
  assert.deepEqual(sliceAfterMarker("a\nb\n", "pico-mcp-window-zzz"), { markerSeen: false, lines: [] });
});

test("openLogWindow writes exactly one `log -t pico-mcp <marker>` and never a clear", async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
  const window = await openLogWindow(run, "fixture-serial");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 5), ["-s", "fixture-serial", "shell", "log", "-t"]);
  assert.equal(calls[0][5], LOG_WINDOW_TAG);
  assert.equal(calls[0][6], window.marker);
  assert.ok(!calls.some((a) => a.includes("-c")));
});

test("readLogWindow always includes the marker tag in its filter and bounds the dump", async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return { code: 0, stdout: `x\nI ${LOG_WINDOW_TAG}: m1\nAgentBridge: dump_begin\n`, stderr: "" }; };
  const result = await readLogWindow(run, { serial: "fixture-serial", marker: "m1", openedAt: "t" }, { tags: ["AgentBridge"], maxLines: 500 });
  assert.equal(result.markerSeen, true);
  assert.deepEqual(result.lines, ["AgentBridge: dump_begin"]);
  assert.ok(calls[0].includes("-d") && calls[0].includes("-t") && calls[0].includes("500"));
  assert.ok(calls[0].includes("AgentBridge:V") && calls[0].includes(`${LOG_WINDOW_TAG}:V`) && calls[0].includes("*:S"));
  assert.ok(!calls[0].includes("-c"));
});
```

- [ ] **Step 2: Run; expect FAIL (module missing). Implement `src/logwindow.ts` per the interface (marker = `pico-mcp-window-${randomUUID()}`; `buffers` maps to repeated `-b <name>`; default `maxLines` 4000; `raw` is the dump text).**

- [ ] **Step 3: Run `test/logwindow.mjs`; expect PASS. Commit.**

```bash
git add src/logwindow.ts test/logwindow.mjs
git commit -m "feat: marker-correlated bounded log windows replace global logcat clearing"
```

- [ ] **Step 4: Replace every implicit clear.** For each site: open a window BEFORE the action that produces the lines, read the window after, report `serial` and `logWindow`, and treat `markerSeen:false` as inconclusive:

  - `src/assertscene.ts:76` (`assert_scene`): `const window = await openLogWindow(runner, dev);` … after the broadcast and settle, `const { markerSeen, lines } = await readLogWindow(runner, window, { tags: [tag] });` → `parseDump(lines.join("\n"))`; when `!markerSeen` return `{ error: "log window marker was evicted before the dump was read on <dev>; the buffer was not cleared, re-run" , serial: dev, logWindow }`.
  - `src/sense.ts:576` (`probe_planes`): same pattern with `tags: [t, "AgentBridge"]` inside the poll loop (one window opened before the broadcast; each poll re-reads the same window).
  - `src/copilot.ts:65` (`snapshot`): same, `tags: ["AgentBridge"]`.
  - `src/workflow.ts:383` (`build_and_run`): open the window before launch instead of clearing; every later logcat read in that handler reads the window; `report.steps.push({ logWindow: { marker, markerSeen } })`.
  - `src/doors.ts:1016` (`pico_loop`): `const marker = newLogMarker(); await call("adb_shell", { command: \`log -t ${LOG_WINDOW_TAG} ${marker}\` }).catch(() => {});` and pass `sinceMarker: marker` to every `assert_logcat` call in that iteration (line 1071).
  - `src/adb.ts:419` (`assert_logcat`): new input `sinceMarker: z.string().optional()`; `clearFirst` KEPT for compatibility but re-described ("opens a marker window instead of clearing the device log; equivalent to sinceMarker with a fresh marker") and implemented as `openLogWindow`; the poll matches only `sliceAfterMarker(stdout, marker).lines` when a marker is in play; the result carries `serial`, `logWindow`.
  - `src/agentloop.ts:150` (`wait_for_log`): same treatment; default `clearFirst: true` now opens a window.
  - `src/boundaryexperiment.ts:3011`: replace `logcat -b all -c` with `openLogWindow` and read `-b all` through `readLogWindow(..., { buffers: ["all"] })` into `prepare-logcat-all.txt` (write `lines`, plus a first line `# window marker <marker> seen=<bool>`); an unseen marker is a `BoundaryPreparationFailure` with `structuralStop: "log_window_evicted"` — never a silent pass.
  - `src/adb.ts:338` (`logcat` tool `clear:true`): the ONE explicit destructive clear stays, but `clear` now requires an explicit `serial` (no sole-device resolution) and the description says "destructive: erases the device's global log buffer; explicit serial required".

- [ ] **Step 5: Add the source-level guard to `test/logwindow.mjs`:**

```js
test("no src file clears logcat implicitly; the explicit logcat tool is the only clear", () => {
  const src = new URL("../src/", import.meta.url);
  const offenders = [];
  for (const name of fs.readdirSync(src).filter((n) => n.endsWith(".ts"))) {
    const text = fs.readFileSync(new URL(name, src), "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (/"logcat",\s*(?:"-b",\s*"[a-z]+",\s*)?"-c"/.test(line) || /logcat -c/.test(line)) offenders.push(`${name}:${index + 1}`);
    }
  }
  assert.deepEqual(offenders, ["adb.ts:<line of the explicit clear>"], offenders.join(", ")); // pin the one allowed site by file:line
});
```

- [ ] **Step 6: Rebuild; run the suites that fixture these tools (`test:doors`, `test:emulator-restart`, `test:conformance` for boundaryexperiment, `test:preflight`, `test:picocli`, `test:observation`, `test/logwindow.mjs`); expect PASS. Register `test/logwindow.mjs` in the inventory (`test:observation`'s command list is the natural home — add `"test/logwindow.mjs"` to it; `validateGateInventory` derives the counts). Commit.**

```bash
git commit -am "fix: observation paths open marker windows instead of clearing the device log"
```

---

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

### Task 6: Rebuild, regressions, independent review, final battery, fresh artifact and checkpoint

**Files:**
- Create: `docs/findings/CLI050_HOST_COMPLETION_CHECKPOINT.md`, `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/host-completion/pico-spatial-mcp-38.0.0.tgz` (untracked) + `.receipt.json` (tracked), `evidence/…/host-completion/*.log`
- Modify: `CHANGELOG.md` (38.0.0 section: the six fixes), `docs/findings/CLI050_CAPABILITY_MATRIX.md` (pico_perf device), `AGENTS.md` (run-gate sentence if T1 did not already finish it)

- [ ] **Step 1: `npm run build`; run every gate T1–T5 touched (`test:lint`, `test:docsmeta`, `test:distribution-adoption`, `test:doors`, `test:sdkselection`, `test:observation`, `test:eye`, `test:tarball`, `test:claims`, `test:runrevision`, `test:buildfreshness`, `test:plugin-bootstrap-freshness`, `test:picocli`, `test:conformance`, `test:emulator-restart`, `test:preflight`) with logs under `evidence/…/host-completion/`.**
- [ ] **Step 2: Independent whole-pass review (read-only reviewer, fresh context) over `dfb3f2d..HEAD`; one fix wave if findings; one scoped re-review.**
- [ ] **Step 3: Full battery through `node scripts/run-battery.mjs "$PWD" evidence/…/release/host-completion/battery-38.0.0-host-completion.log` with NO `PICO_ADB` exported and a marker-writing tripwire `adb` first on `PATH`; expected 55/55 (no exceptions). Record the tripwire marker's absence.**
- [ ] **Step 4: `node scripts/verify-tarball.mjs --publish "$PWD/evidence/…/release/host-completion/pico-spatial-mcp-38.0.0.tgz"`; track the receipt; quote sha256/bytes/build identities; confirm the two earlier tarballs' hashes are unchanged.**
- [ ] **Step 5: Write `docs/findings/CLI050_HOST_COMPLETION_CHECKPOINT.md`: what changed per task with commits and tests; the battery; the artifact lineage (three 38.0.0 artifacts, each with receipt identities, the earlier two labeled superseded and byte-identical); the incident records referenced (not rewritten) with a sentence that the clearing mechanism is removed; precise remaining acceptance limits (profiler provisioning, host discovery, Linux/Windows `tools/list`, emulator LOOK, physical device; perf-lane default target retained by choice; `pico_look` default target retained by choice). Update CHANGELOG 38.0.0 and the capability matrix. Run `test:docsmeta`, `test:distribution-adoption`, `test:lint`; commit.**

---

## Self-review

- Spec coverage: item 1 → T1 (pin regardless of inherited value, blank fails closed, harness override, all doors through the seam with a `{}` test); item 2 → T2 (fixture ledger + opt-in live comparison, scaled child clock, no production constant changed); item 3 → T3 (fallback removed, fail closed, unique retained canonical/emulator-look paths, default target unchanged); item 4 → T4 (every implicit clear replaced, marker windows, explicit serial + logWindow in results, one explicit destructive clear left with a required serial, incident text untouched); item 5 → T5 (Node major + provenance, selected toolchain watch, perf device pass-through, historical references preserved); item 6 → T6.
- Type consistency: `gateChildEnv(gate, env, io)`, `HARNESS_ADB_VARIABLE`, `observationCapturePath(kind, fileName)`, `openLogWindow/readLogWindow/sliceAfterMarker/newLogMarker/LOG_WINDOW_TAG`, `verifyDependencies(...).provenance`, `installedVersions(io)` are used with the same names throughout.
- Placeholders: T4 Step 5 pins one `file:line` the implementer fills from the tree after Step 4 (the explicit clear's real line); T2 Step 1 tells the implementer to read the writer signatures in `dist/ledger.js` before finalizing the fixture entries. Both are deliberate reads of the tree, not deferred design.
