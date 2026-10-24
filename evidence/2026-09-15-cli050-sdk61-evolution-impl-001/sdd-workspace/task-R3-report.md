# Task R3 — Own gate commands and host assignments in one inventory

**Status:** DONE
**Worktree:** `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-release-2026-09-15` (branch `track/cli050-release`)
**Commit:** `22c2740` — `fix: make gate inventory complete and source-bound` (not pushed)
**Base:** `685e8d9` (Tasks R1–R2 complete and reviewed)

---

## What I implemented

### `scripts/gate-inventory.mjs` (new, 216 lines) — the single declaration

| Export | Behaviour |
| --- | --- |
| `GATES` | `Record<string,{host:'linux'\|'windows'\|'macos', commands:string[][], scope:'fixture'\|'native-contract'\|'installed-artifact'}>`, frozen. 51 entries: `smoke` + 50 `test:` suites, in battery order. |
| `GATE_HOSTS`, `GATE_SCOPES` | The closed vocabularies the shape checks validate against. |
| `isGateScriptName(name)` | `smoke` or `test:*`. This is what makes `build`/`prepack`/`sync:meta`/`start` structurally not gates — no allowlist to maintain. |
| `gateScriptCommand(name)` | `node scripts/run-gate.mjs <name>` — the only body a gate script may have. |
| `hostFamilyForRunner(runsOn)` | `ubuntu-*`→`linux`, `windows-*`→`windows`, `macos-*`/`mac-*`→`macos`, anything else → `null` (never a guess). |
| `hostFamilyForPlatform(platform)` | `win32`→`windows`, `darwin`→`macos`, else `linux`. |
| `gatesForHost`, `gateHostCounts`, `gateInventoryCounts` | Derived views. `gateInventoryCounts()` returns `{invocations, suites, hosts}` — the numbers the docs publish. |
| `parseWorkflowLanes(workflow)` | `[{job, runsOn, host, gates}]`. Jobs are the 2-space keys under `jobs:`; a gate invocation is `npm run <gate-shaped name>` on a non-comment line. `npm ci` and `npm run build` are simply not gate-shaped, so no exclusion list exists to rot. |
| `validateGateInventory(pkg, workflow, gates=GATES)` | `string[]`, never throws. Reports all five classes: script missing from `GATES`; `GATES` entry missing from scripts; gate no lane invokes; gate invoked more than once; gate run by a lane whose runner OS disagrees with its host. Plus a sixth fail-closed case: a lane whose `runs-on` maps to no host family. |

`commands` preserves each old script's full `&&` tail as sequential argv arrays — `test:lint`, `test:eye`, `test:bridge`, `test:picocli`, `test:conformance` all keep both segments, asserted individually.

### `scripts/run-gate.mjs` (new, 156 lines) — freshness, then execution

- `GATE_TIMEOUT_MS = 30 * 60 * 1000`, documented in-file as a hang detector rather than a budget.
- `STALE_BUILD_MESSAGE = "Build output is stale; run npm run build first."` — the error message starts with exactly the brief's string, then names the gate, its scope, and `verifyBuild`'s reasons.
- `runGate(name, {root, env, gates, verify, timeoutMs, platform, spawnChild})`: unknown name throws; `fixture` and `installed-artifact` scopes call `verifyBuild(root)` and throw **before any child exists**; `native-contract` skips the check (documented: those are shell scripts compiling native sources, they never load `dist/`, so a stale TypeScript build is not their problem and checking it would only produce a confusing failure). Then each argv runs sequentially, returning the first nonzero exit.
- `runArgv(argv, …)`: `spawn(argv[0], argv.slice(1), {cwd:root, env, shell:false, stdio:'inherit', timeout})`. Spawn throw, `error` event and kill-by-signal all resolve nonzero (never reject) with a `[run-gate]` diagnostic, so the remaining commands of that gate are skipped identically in every failure mode. A `settled` guard makes `error`+`close` idempotent.
- `gateLaunch(argv, platform, env)`: `node`/`sh` spawn directly; only `npm` goes through `npmLaunch` from `scripts/plugin-bootstrap.mjs` (the existing audited Windows path). No gate currently invokes npm — this exists so adding such a gate later cannot quietly become the shape that breaks the Windows lane.
- CLI: `node scripts/run-gate.mjs <name>`; usage error → 2, thrown error → 1 with the message on stderr.

### `scripts/run-battery.mjs` — aggregator over `GATES`

- `batteryPlan({platform, gates})` → `{host, run, skipped:[{name,host}]}`. `discoverBatteryCommands` (package-script discovery) is gone.
- `reserveBatteryLogPath(logPath)` claims the requested name with `openSync(…, "wx")`, else the first free `<log>.1`, `<log>.2`, …. `runBattery` reserves and returns `logPath` — previous evidence is never truncated.
- Run-all-after-failure, section retention and the exact summary line are unchanged. When gates were skipped the summary gains `; N skipped off-platform (linux: 48, …)` and the log header lists them by name, so a short PASS can never be read as a whole-battery PASS.

### Routing, workflow and docs

- All 51 gate scripts in `package.json` are now `node scripts/run-gate.mjs <name>`; `build`, `prepack`, `sync:meta`, `start` untouched. Two new scripts added: `test:buildfreshness`, `test:plugin-bootstrap-freshness`.
- `.github/workflows/gates.yml`: three steps added to the Linux lane (`test:runrevision`, `test:buildfreshness`, `test:plugin-bootstrap-freshness`); the lint step renamed to mention the gate-inventory contract; the battery comment rewritten to state the *shape* instead of a hand-typed "47-invocation" total. Windows and macOS lanes unchanged.
- `test/buildrun-smoke-fixture.mjs:60–68` migrated from matching filenames inside the package script string to the exact resolved inventory command (brief snippet verbatim), plus a check that the script is the dispatcher. Both workflow assertions retained.
- `test/lint.mjs` battery block and `test/distribution-adoption.mjs`'s two inventory tests now compute every expectation from `GATES` + the parsed workflow. No literal totals remain in either.

### Exact doc count lines changed

| File | Before | After |
| --- | --- | --- |
| `README.md:318` | `The full gate battery has 47 gate invocations (46 \`test:\` suites plus \`smoke\`). CI assigns 44 to` | `The full gate battery has 51 gate invocations (50 \`test:\` suites plus \`smoke\`). CI assigns 48 to` |
| `docs/COLLABORATORS.md:15` | `…the deterministic gate battery, 47 gate invocations (46 \`test:\` suites plus \`smoke\`):` | `…the deterministic gate battery, 51 gate invocations (50 \`test:\` suites plus \`smoke\`):` |
| `AGENTS.md:24` | `51 of 60 files in \`test/\` import \`../dist/*.js\`;` | `60 of 82 files in \`test/\` import \`../dist/*.js\`;` |
| `AGENTS.md:41–44` | the `**\`test:runrevision\` runs in no workflow, and the meta-gate … is itself red**` gotcha | replaced by `**One inventory owns every gate command and its CI lane.**`, describing `GATES`/`run-gate`/`validateGateInventory` and naming `test:runrevision` as the historical case |

The `51`/`50`/`48` values were **generated** from `gateInventoryCounts()` by a one-shot script, not typed. `AGENTS.md:24`'s `60 of 82` is a fresh static scan (`test/*.mjs` = 82 files, 60 import `../dist/`). No sync/count script owns gate-battery counts — `scripts/metadata-counts.mjs` and `scripts/sync-metadata.mjs` only own tool counts and versions (verified by inspection: neither mentions gates, invocations or suites), so no second mechanism was added.

---

## TDD: RED → GREEN

**RED 1** — `test/gate-inventory.mjs` written first, before either script existed:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/scripts/gate-inventory.mjs'
  imported from …/test/gate-inventory.mjs
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

**RED 2** — after implementing `gate-inventory.mjs` + `run-gate.mjs` but before touching `package.json`/`gates.yml`, 7 of 29 failed for exactly the drift the validator is for (22 passed, including all `runGate`/`runArgv` behaviour):

```
✖ the repository's package.json and gates.yml agree with the inventory
✖ every public gate script is routed through run-gate, and nothing else is
✖ a gate invoked twice is reported as a duplicate
✖ a workflow step invoking an unknown gate is reported
✖ a gate run by a lane whose runner OS disagrees with its host is reported
✖ a package script with no host assignment is reported
✖ workflow lanes carry their job name, runner, host family, and gate invocations
ℹ tests 29  ℹ pass 22  ℹ fail 7
```
with findings including `the inventory declares test:buildfreshness, which package.json does not expose as a script` and `test:runrevision is assigned to linux but no workflow lane ever invokes it`.

The four mutation cases are real text mutations of the repository's own `package.json`/`gates.yml`: the brief's `workflow.replace('npm run test:runrevision','npm run build')`; a step appended inside the Linux job (duplicate, then unknown); the Linux `test:ledger` step physically **moved** into the macOS job (host mismatch — asserted to be the *only* finding); an added `test:orphan` script; a deleted `test:ledger` script; and `runs-on: macos-latest` → `solaris-latest`. No numeric total is asserted anywhere in the suite — a synthetic 2-gate inventory exercises the same shape checks to prove that.

**GREEN** — `node --test test/gate-inventory.mjs` → 29/29.

---

## Tests and results (all host-executed in this worktree)

| Command | Result |
| --- | --- |
| `npm run build` | `published 182 file(s) for source 8eeac004b6a6` |
| `node --test test/gate-inventory.mjs test/buildrun-smoke-fixture.mjs` | **40 pass / 0 fail** |
| `node --test test/run-battery.mjs test/gate-inventory.mjs` | **40 pass / 0 fail** |
| `npm run test:lint` | **Failures: 0**; 40 pass / 0 fail. Was **3 FAIL** at HEAD. |
| `npm run test:distribution-adoption` | **43 pass / 0 fail**. Was **2 fail** at HEAD. |
| `npm run test:runrevision` | **327 pass / 0 fail** (122 s) |
| `npm run test:docsmeta` | **Failures: 0** (`sync-metadata --check`: no stale literals; 162 links resolve) |
| `npm run test:tarball` | **Failures: 0** (installed copy lists 255 tools, 18 doors) |
| `node scripts/run-gate.mjs test:prompts` | 3 pass, **exit 0** |
| `node scripts/run-gate.mjs test:buildfreshness` | 26 pass, **exit 0** |
| `node scripts/run-gate.mjs test:plugin-bootstrap-freshness` | 27 pass, **exit 0** |
| `node scripts/run-gate.mjs test:picocli-win` (Windows lane content, run on macOS) | 113 pass, **exit 0** |
| `npm run test:ledger`, `npm run test:doors` | Failures: 0 — clean-shell spot checks of the dispatcher |
| `git diff --check` | clean |

The previously-red lint messages, verbatim at HEAD and now absent:
`battery: package.json declares gates that gates.yml never runs: test:runrevision`,
`battery: README.md claims 47 invocations / 46 suites; package.json + gates.yml say 49 / 48`,
`battery: docs/COLLABORATORS.md claims 47 invocations / 46 suites; …`.
`test:lint` now prints:
`ok   published gate-battery size agrees across scripts/gate-inventory.mjs, package.json, gates.yml, README.md, and docs/COLLABORATORS.md (51 invocations / 50 test: suites; linux 48, windows 1, macos 2)`.

### Stale-build proof (real, twice)

**Unplanned, and the better evidence:** `verifyBuild`'s input identity covers `package.json`, so the moment I routed the scripts, the very next `npm run test:distribution-adoption` refused:

```
[run-gate] Build output is stale; run npm run build first. test:distribution-adoption (scope fixture) reads emitted output.
  - the source input identity changed since the build (b65f30ff49e0 -> 8eeac004b6a6)
```

**Deliberate:** appended a comment to `src/doors.ts`, then:

```
--- run-gate test:prompts against a stale build ---
[run-gate] Build output is stale; run npm run build first. test:prompts (scope fixture) reads emitted output.
  - the source input identity changed since the build (8eeac004b6a6 -> a878f5b3dcb3)
EXIT=1
--- run-gate test:vcamtransport-native (native-contract, skips freshness) ---
cmio-camera-writer lifetime test: … passed
cmio-camera-writer native gate: strict build, ownership lifetime, parser, cadence-flag validation, … passed
EXIT=0
```

No test output at all in the stale case — the refusal happens before any child exists — and the native-contract exception is proven in the same breath by a gate that really compiled Swift on this macOS host against the same stale build. `src/doors.ts` reverted; `verifyBuild` back to `{"current":true,"reasons":[]}`.

**Not run:** `npm run smoke` and a full `node scripts/run-battery.mjs` pass, per the task's exclusion (they run the non-hermetic smoke/native gates). The `smoke` dispatch is byte-identical in form to the 50 dispatchers proven above, but I did not execute it.

---

## Decisions inside the brief's latitude

1. **Both new suites are Linux-only.** The resolution allowed the Windows lane "if they pass there". They do not: `test/plugin-bootstrap-freshness.mjs:940–954` writes a fake npm at `npm.cmd` on `win32` whose body is a Node script with a `#!/usr/bin/env node` shebang — cmd.exe cannot execute that — and `test/buildfreshness.mjs` depends on SIGTERM/SIGKILL and zombie-reaping semantics that differ on Windows. I have no Windows host, so I kept both on Linux and am saying so explicitly rather than guessing.
2. **`test/gate-inventory.mjs` is gated through `test:lint`,** whose second command became `node --test test/run-battery.mjs test/gate-inventory.mjs`. The brief permits "existing appropriate fixture suites or deliberate new named entries", and the lint gate is already the repo self-consistency + battery-runner lane. This keeps the gate-count delta to exactly the two entries the resolution named. `test:picocli-win`'s command array is untouched, as the brief pins it.
3. **`validateGateInventory` reports exactly the five listed classes** plus an unrecognized-runner case (fail-closed: a `runs-on` the parser cannot classify is a finding, not a silent pass). It deliberately does **not** check that a script's *body* is the dispatcher — that lives in `test/gate-inventory.mjs`'s own test, which runs inside `test:lint`, so CI still catches a hand-edited body.
4. **AGENTS.md's `test:runrevision` gotcha was rewritten,** not just its counts. My change falsifies both halves of that paragraph ("runs in no workflow", "the meta-gate … is itself red"). My boundary said "stale count sentences only"; I judged that leaving a knowingly-false gotcha in the file my change falsified was worse than the narrow overreach, and it is the one edit here a reviewer may want to revert. It is outside the policy markers and uses none of the guarded policy vocabulary.

---

## Self-review

- **Completeness.** Every brief checkbox: `GATES` populated from all existing gates with no dropped `&&` tail ✓; new suites registered ✓; `test:runrevision` on Linux, natives on macOS, shim on Windows ✓; four drift classes with retained RED ✓; every public script routed, `build`/metadata/`start` left alone ✓; stale-gate refusal before children ✓; `buildrun-smoke-fixture` migrated to the resolved command with all three constituent suites ✓; `runArgv` local, `shell:false`, bounded, Windows npm handling reused ✓; battery + published counts derived from `GATES` with set equality ✓; mutation cases for a source edit preventing all children and an unassigned script ✓; run-all-after-failure kept and log files reserved ✓. Both baseline-red gates green ✓.
- **Discipline / boundaries.** `src/**`, `scripts/build-*.mjs`, `scripts/plugin-bootstrap.mjs`, `scripts/verify-tarball.mjs`, `test/smoke.mjs`, `test/docsmeta.mjs` untouched (`git show --stat` lists 13 files, none of them). No policy-block byte changed: `git diff` over README/AGENTS/GETTING_STARTED/TESTERS/SKILLS/docs/HOSTS greps zero lines containing `managed-latest`, `PICO_MCP_CLI*`, `registry-latest` or the policy markers; README/COLLABORATORS diffs are one line each; `test:distribution-adoption` (which pins the block) is green.
- **Quality.** One responsibility per file: inventory declaration + validation; freshness + execution; aggregation. Every non-obvious choice carries a why-comment (the `native-contract` exception, the comment-line filter, the log reservation, the timeout's purpose). Node 20 APIs only — no `Object.groupBy`, no `Array.fromAsync`.
- **Testing.** Validator cases mutate the repository's real `package.json`/`gates.yml` text (including physically moving a step between jobs), and three of them assert the finding is the *only* one, so an over-broad validator would fail. `runGate` freshness is proven both with an injected verifier (asserting `record.length === 0`) and with a real edited source file.
- **Windows meaning preserved.** `test:picocli-win` still resolves to the identical three-suite `node --test` line, on the `windows` host, run by the same lane step. Its content passes locally (113 tests).

## Concerns

1. **`run-battery` on macOS now plans 2 gates, not 51.** This follows resolution 4 literally ("respecting host assignment for the current platform; off-platform gates are reported as skipped, never run"). On a Darwin dev box the battery now runs only the two CMIO contracts and reports 49 skips. I mitigated the over-claim risk by putting the skip count in the summary line itself (`BATTERY PASS 2/2 (0 failed); 49 skipped off-platform (linux: 48, windows: 1)`) and listing skipped names in the log header — but if the intent was "run everything that is meaningful here, skip only the other host's *native* contracts", the one-line change is in `batteryPlan`. Flagging because it materially changes a developer tool, and historical docs still say `SMOKE_SDK_OPTIONAL=1 node scripts/run-battery.mjs` as if it were a full run.
2. **`spawn('node', …, {shell:false})` on Windows is unexecuted here.** libuv's path search appends `PATHEXT`, so `node`→`node.exe` resolves, and I kept `argv[0]` literal because the brief specifies `spawn(argv[0], argv.slice(1), …)`. If the Windows lane ever fails to start a child, mapping the literal `node` to `process.execPath` inside `gateLaunch` is the fix. I could not test it.
3. **`run-gate` uses `verifyBuild`, which needs a source checkout.** An installed tarball has no `src/`, so `npm run test:*` from an installed copy would report stale rather than using R2's `verifyEmittedOutput`. Gates only ever run in a checkout and `test/` is not packaged, so this is unreachable today — but it is the seam to change if gates are ever shipped.
4. **`evidence/2026-09-15-…/RELEASE_AND_GATE_AUDIT.md:94`** ("`scripts/run-battery.mjs:46` overwrites its configured log") is now false. I left it untouched as dated evidence per the preserve-evidence constraint.
5. **A workflow using `runs-on: ${{ matrix.os }}`** would classify as an unrecognized runner and fail `validateGateInventory`. Deliberate (fail-closed), but whoever adds a matrix-OS lane must extend `hostFamilyForRunner` rather than be surprised.

---

# Fix round 1

**Commit:** `f8c78c7` — `fix: run cross-platform gates on every host and bound gate children` (not pushed)
**Base:** `22c2740`
**Files:** `scripts/run-battery.mjs`, `scripts/run-gate.mjs`, `test/run-battery.mjs`, `test/gate-inventory.mjs`, `AGENTS.md`. No other ledgered item touched.

## 1. `batteryPlan` splits on scope, not host — accepted, fixed

The reviewer is right, and this was my own concern #1 resolved in the better direction. `host` is a CI lane assignment, not an exclusivity claim; only `native-contract` gates are genuinely OS-bound.

```js
if (gate.scope !== "native-contract" || gate.host === host) run.push(name);
else skipped.push({ name, host: gate.host });
```

The doc comment now says why in those terms, and keeps the original reason the skip exists at all: off their own OS the two CMIO shell scripts print "skipped" and exit 0 — green output for a contract that compiled nothing.

`test/run-battery.mjs` updated in both places. The synthetic-plan test was retitled ("skips by scope, not by lane") and now asserts full `{host, run, skipped}` objects for all three platforms, including that a Windows-lane *fixture* gate runs on Linux. The repository-plan test now derives the expected `run` list as *every non-native-contract gate* and asserts set equality, so it cannot drift:

```js
const crossPlatform = Object.entries(GATES).filter(([, g]) => g.scope !== "native-contract").map(([n]) => n);
assert.deepEqual(linux.run, crossPlatform);
assert.deepEqual(linux.skipped, [{name:"test:vcamtransport-native",host:"macos"},{name:"test:vcamreader-native",host:"macos"}]);
assert.deepEqual(macos.run, Object.keys(GATES));   // macOS owns both contracts, so it runs everything
assert.deepEqual(macos.skipped, []);
```

**Measured plans, all three platforms** (`node -e` against the real inventory):

```
linux   host=linux    run=49 skipped=2 ["test:vcamtransport-native","test:vcamreader-native"]
darwin  host=macos    run=51 skipped=0 []
win32   host=windows  run=49 skipped=2 ["test:vcamtransport-native","test:vcamreader-native"]
inventory size: 51
```

**This macOS host, by scope:**

```
platform: darwin -> host: macos
run: 51 {"fixture":48,"installed-artifact":1,"native-contract":2}
skipped: 0 []
includes test:tarball? true
includes test:picocli-win? true
every fixture/installed-artifact gate planned? true
```

**Real CLI dispatch dry run.** There is no `--plan-only` flag and I did not add one (scope). Instead I drove the *real* `runBatteryCli` with the real inventory and this host's real platform, replacing only the npm spawn with a recorder, writing to a fresh `/private/tmp` log:

```
battery checkout: /Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-release-2026-09-15
host: macos
log: /private/tmp/pico-r3-fix1-battery-plan-1789479166.log (a fresh file is reserved if that name is taken)
PASS 1/51 smoke (0.0s)
PASS 2/51 test:tarball (0.0s)
…
BATTERY PASS 51/51 (0 failed)
dispatched 51 gates (no gate executed)
```

Log header `PICO gate battery (51 invocations)`, 51 `npm run` sections, no skip line. **Every "PASS" there is a recorded dispatch, not a test result — no gate was executed by this dry run.**

## 2. `AGENTS.md:24` count — re-measured with a stated definition

The reviewer's figures reproduce exactly; my 82 denominator was measured *before* this task added `test/gate-inventory.mjs`, and my numerator used a definition I never wrote down. Measured now at `22c2740`:

| Definition | Command | Count |
| --- | --- | --- |
| `test/*.mjs` files | `ls test/*.mjs \| wc -l` | **83** |
| contain `../dist/` anywhere | `grep -l '\.\./dist/' test/*.mjs \| wc -l` | 65 |
| **static or dynamic import specifier starting `../dist/`** | `grep -lE '(from\|import\()[[:space:]]*"\.\./dist/' test/*.mjs \| wc -l` | **60** |
| `from "../dist/` only | `grep -lE 'from[[:space:]]*"\.\./dist/' test/*.mjs \| wc -l` | 45 |

The 45→60 gap is 15 files that reach `dist/` only through dynamic `import("../dist/…")` — verified by listing the set difference (`test/ledger.mjs`, `test/conformance.mjs`, `test/vcam.mjs`, …). Those files really do import `dist/`, so the import-specifier definition is the one the gotcha is about.

The sentence now carries its own definition and command, so it is checkable without guessing:

> **Tests import `dist/`, and nothing rebuilds it.** 60 of the 83 `test/*.mjs` files carry a
> static or dynamic import specifier starting `../dist/`
> (``grep -lE '(from|import\()[[:space:]]*"\.\./dist/' test/*.mjs | wc -l``);

## 3. `AGENTS.md` native-contract exemption — added

> refuses a gate whose `dist/` is stale before spawning anything — except the two `native-contract`
> shell gates, which compile native sources and never load `dist/`.

## 4. `run-gate` is now actually bounded

`spawn`'s `timeout` option is no longer passed. It sends one signal and then waits forever, so a SIGTERM-ignoring child was never bounded. The runner owns the ladder:

- `GATE_KILL_GRACE_MS = 5_000`, exported and documented alongside `GATE_TIMEOUT_MS`.
- At `timeoutMs`: log, `child.kill("SIGTERM")`, start the grace timer. At `+graceMs`: log, `child.kill("SIGKILL")`. Both `kill` calls are try/caught (an already-exited child still settles through `close`); both timers are `unref()`ed and cleared in `settle`, which is idempotent, so no timer outlives the promise.
- A `timedOut` flag makes the outcome nonzero even if the child manages to `close` with code 0 after being signalled.
- `graceMs` threads through `runGate`.

**New tests (2):**

- *"a real child that ignores SIGTERM is still bounded: SIGKILL lands after the grace"* — spawns a real fixture (`process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);`) with `timeoutMs: 300, graceMs: 700`, asserts exit 1, `elapsed >= 300`, and `elapsed < timeout + grace + 6 s`. Observed **1009 ms**, with the escalation visible on stderr:

```
[run-gate] node …/ignores-sigterm.mjs exceeded 0s; sending SIGTERM
[run-gate] node …/ignores-sigterm.mjs ignored SIGTERM for 1s; sending SIGKILL
[run-gate] node …/ignores-sigterm.mjs was terminated by SIGKILL after exceeding 0s
✔ a real child that ignores SIGTERM is still bounded (1009.049208ms)
```

- *"a timed-out gate stops before its remaining commands"* — a stalling fake that only closes on SIGKILL; asserts `exit === 1` and that the gate's second command never spawned.

The existing options assertion changed from `typeof options.timeout === "number"` to `options.timeout === undefined` with the reason inline ("the runner owns the SIGTERM->SIGKILL ladder; spawn's one-signal timeout is not a bound"), plus a check that both rungs are positive. The fake spawn gained a `kill` stub.

## Fix-round tests and results

| Command | Result |
| --- | --- |
| `npm run build` | `published 182 file(s) for source 8eeac004b6a6` |
| `node --test test/gate-inventory.mjs test/run-battery.mjs test/buildrun-smoke-fixture.mjs` | **53 pass / 0 fail** (was 51; +2 bound tests) |
| `node --test --test-name-pattern="ignores SIGTERM" test/gate-inventory.mjs` | 1 pass, SIGTERM→SIGKILL escalation on stderr, 1009 ms |
| `npm run test:lint` | **Failures: 0**; 42 pass / 0 fail; `ok published gate-battery size agrees … (51 invocations / 50 test: suites; linux 48, windows 1, macos 2)` |
| `npm run test:distribution-adoption` | **43 pass / 0 fail** |
| `npm run test:docsmeta` | **Failures: 0** (162 links, `sync-metadata --check` clean) |
| battery dispatch dry run (macOS, real CLI) | 51/51 planned and dispatched, 0 skipped, log `/private/tmp/pico-r3-fix1-battery-plan-1789479166.log` |
| `git diff --check` | clean |
| policy guard: `git diff AGENTS.md README.md \| grep -ciE "managed-latest\|PICO_MCP_CLI\|registry-latest\|pico-mcp-managed-cli-policy"` | **0** |

## Notes

- Concern 1 from the original report is **closed** by this round. Concerns 2–5 stand unchanged, except that concern 2's Windows note now also covers `child.kill("SIGTERM")`: on Windows `kill` terminates outright rather than delivering a signal, so the ladder's first rung already ends the child there. The bound still holds (settles at `timeoutMs`); the grace rung is simply unused on Windows. `test/gate-inventory.mjs` runs only in the Linux `test:lint` lane, so CI exercises the real POSIX path.
- The gate *count* is unchanged (51 / 50); `test:lint` and `test:distribution-adoption` still derive it. Only the battery's per-host **plan** changed, which no published count depends on.
