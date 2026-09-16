# Task R4 — Make default smoke hermetic and host integration explicit

**Status:** DONE
**Worktree:** `/Users/sushantsrikrish/PICO-MCP/.worktrees/cli050-track-release-2026-09-15` (branch `track/cli050-release`)
**Commit:** `13c93ad` — `test: isolate smoke from personal SDK projects` (not pushed)
**Base:** `f8c78c7` (Tasks R1–R3 complete and reviewed)

---

## What I implemented

### `test/smoke.mjs` — hermetic by construction, not by environment

The old file computed a project/bundle path from `os.homedir()`, packed a real bundle with the
host's `spatialbundle`, and enumerated real devices. It now builds the server's whole environment
itself and never consults the host for tooling.

| Removed | Moved to | Kept |
| --- | --- | --- |
| the Claimsight project/bundle constants | — | tool registration (`EXPECTED` + macOS-only exemptions) |
| `SMOKE_SDK_OPTIONAL` + the `ENV_MISS` error-text skip regex | — | prompts listing |
| `validate_toolchain`, `emulator_list` | `test/sdk-integration.mjs` | typed `outputSchema` advertisement |
| real `pack_bundle` / `inspect_bundle` ×2 | `test/sdk-integration.mjs` | `preflight_env`, `diagnose`, `capability_report` ×2, `verify` structuredContent |
| `scene_schemas`, `xr_grpc_describe` | `test/sdk-integration.mjs` | the fake-Gradle/adb `build_and_run` success path |

Both server spawns now share one fixture environment from `buildRunSmokeFixtureEnv`: `PICO_HOME` =
an existing-but-empty tools root, `HOME`/`USERPROFILE` = a fixture home, `PICO_MCP_SURFACE=full`,
`PICO_MCP_CLI_POLICY=disabled`, and a PATH whose first entry is the fixture bin. The environment is
constructed explicitly, never spread from `process.env` — the string `process.env` does not appear
in `test/smoke.mjs`, and `test/smoke-isolation.mjs` asserts that.

**Why `disabled` and not `managed-cached`:** none of the retained checks inspects a CLI cache, so
the least capable policy is the correct one. It is also a second, independent guard: the registry
lookup and the install both go through `io.run("npm", …)` (`src/picoclimanaged.ts:1240,1552`), so
the poisoned `npm` on PATH catches them even if the policy were wrong, and `npmCalls.length === 0`
proves neither was attempted.

Smoke now records `{name, status}` per check and prints one machine-readable line,
`SMOKE_SUMMARY <json>`, carrying the check list, the failure count and the fixture invocation log.
Two of its own checks are the isolation claim:

- `fixture invocation log targets only the fixture` — every `calls` entry is fixture-Gradle or
  `fixture-serial`, and no entry anywhere names another serial.
- `no npm invocation` — the npm log is empty.

### `test/helpers/buildrun-smoke-fixture.mjs` — logged, refusing stand-ins

New exports: `FIXTURE_SERIAL`, `buildRunSmokeFixtureEnv`, `readBuildRunSmokeFixtureLog`; the plan
gained `npmPath`, `picoHome`, `homeDir`, `invocationLog`, `npmLog`, `serial`.

Every program appends a JSON line to a log whose absolute path is **baked into the driver source**
at materialization time, not read from the environment — a child that loses or rewrites its env
still cannot invoke one silently. Four kinds, deliberately separated:

| kind | meaning |
| --- | --- |
| `fixture-gradle` | the fake Gradle wrapper inside the fixture project |
| `fixture-adb` | a device operation that named `fixture-serial` |
| `fixture-adb-probe` | `adb version` only — prints a version, contacts no device or adb server |
| `fixture-adb-refused` | any other untargeted command, or any other serial: exit 1, nothing done |
| `fixture-npm` | an npm invocation; always refused, exit 66 |

`calls` is exactly `fixture-adb` + `fixture-gradle` — the operations that acted on something — so
the brief's `calls.every(call => call.serial === 'fixture-serial' || call.kind === 'fixture-gradle')`
holds **by construction and honestly**, rather than by relabelling untargeted probes. `adb version`
is answered because that is what makes toolchain discovery resolve to the stand-in instead of a
real adb further down PATH; `adb devices` is refused rather than simulated, because a simulated
device would send `preflight_env` on to `adb -s … shell cat /proc/uptime` and `nc -z 127.0.0.1 8554`
— a real localhost probe of the emulator's gRPC port.

`buildRunSmokeFixtureEnv`'s PATH is `[binDir, /usr/bin, /bin, /usr/sbin, /sbin]` on POSIX. It
deliberately excludes Node's own directory: nothing smoke exercises spawns a bare `node`, and a
future change that does should fail loudly rather than pick up whatever else sits beside the host's
Node (on this machine, a real `adb`). Documented in-file.

The two existing POSIX negative tests in `test/buildrun-smoke-fixture.mjs` were switched from
`{...process.env, …}` to the same `buildRunSmokeFixtureEnv(plan)`, removing host coupling from two
more server spawns.

### `test/sdk-integration.mjs` — the explicit host lane (new, 445 lines)

One file, two modes:

```
node --test test/sdk-integration.mjs                    # the gate: fixtures only, no SDK, no server
node test/sdk-integration.mjs run --project … --bundle … --output …    # the real run, never a gate
```

Exports: `parseIntegrationArgs`, `INTEGRATION_USAGE`, `record`, `checkIntegrationPrerequisites`,
`classifyToolOutcome`, `summarizeIntegration`, `INTEGRATION_STEPS`, `blockedStepRecords`,
`createdOutputDirectory`.

- `parseIntegrationArgs(argv)` → `{projectDir, bundlePath, outputDir}`. All three required, all
  absolute, `--flag value` and `--flag=value` both accepted, duplicates and unknown flags rejected.
  Every error carries the one-line usage string, so `/--project.*--bundle.*--output/` matches.
- Prerequisites, before any tool is invoked: `project-readable` (exists, is a directory, holds a
  `<Name>.spatialproject`), `bundle-readable`, `output-fresh` (`fs.mkdirSync(args.outputDir)` — no
  recursive replacement; EEXIST is a failure that preserves prior evidence), plus two optional-tooling
  records, `spatialbundle-available` and `emulator-payload-available`.
- Steps: `validate_toolchain`, `emulator_list`, `xr_grpc_describe`, `scene_schemas`,
  `inspect_bundle-supplied`, `pack_bundle`, `inspect_bundle-packed`.
- Classification: an MCP `isError`, a thrown call, a schema mismatch, or a pack that produced no
  bundle are each `fail`. A missing payload is a `skipped` naming what was absent — never success.
  A run blocked by its prerequisites still emits a `skipped` record for every step it did not
  reach, so "not attempted" can never read as "fine".

**Documented mutations of the real run:** it creates `--output` and only that directory, writing
`integration.bundle` and `integration-report.json` inside it; `--project` and `--bundle` are opened
read-only; no device is contacted beyond `emulator_list`'s read-only enumeration; nothing is
installed or launched. The report is written **only** when this run created the output directory.

### Gates and derived counts

| | |
| --- | --- |
| New `GATES` entries | `test:smoke-isolation`, `test:sdk-integration` — both `host: "linux"`, `scope: "fixture"`, `["node","--test","test/<file>.mjs"]` |
| New `package.json` scripts | `node scripts/run-gate.mjs <name>`, placed next to `smoke` |
| New `gates.yml` steps | two, in the Linux lane, immediately after the smoke step |
| Removed from `gates.yml` | the smoke step's `env: SMOKE_SDK_OPTIONAL: "1"` |

Counts re-derived from `gateInventoryCounts()`, not typed:

| File | Before | After |
| --- | --- | --- |
| `README.md` | `51 gate invocations (50 …)` / `CI assigns 48 to` | `53 gate invocations (52 …)` / `CI assigns 50 to` |
| `docs/COLLABORATORS.md` | `51 gate invocations (50 …)` | `53 gate invocations (52 …)` |
| `AGENTS.md` | `60 of the 83 test/*.mjs files` | `61 of the 85 test/*.mjs files` |

`61 of 85` re-measured with the command the sentence itself publishes:
`ls test/*.mjs | wc -l` → 85; `grep -lE '(from|import\()[[:space:]]*"\.\./dist/' test/*.mjs | wc -l`
→ 61 (`test/sdk-integration.mjs` reaches `dist/` through a dynamic `import("../dist/toolchain.js")`
in run mode; `test/smoke-isolation.mjs` does not).

### Docs

`README.md`'s Testing section: the `SMOKE_SDK_OPTIONAL` line is gone, `smoke` is described as
fixtures-only, and the explicit integration command plus its mutations are documented in full.
`AGENTS.md`'s smoke gotcha — which my change falsified in both halves — was rewritten (see
*Decisions*, item 3).

---

## TDD: RED → GREEN

`test/smoke-isolation.mjs` was written first, against the unmodified smoke. Full output retained at
`/private/tmp/claude-501/-Users-sushantsrikrish-PICO-MCP/4bdd1daf-f7f3-4942-a5b1-49ca6592bcb5/scratchpad/R4-RED-smoke-isolation.txt`
(203 lines). Both tests failed:

```
✖ default smoke reports the same checks and outcomes whether or not the host home holds an SDK (5253.761458ms)
✖ default smoke cannot select host tooling: no host-home lookup and no environmental escape hatch (0.517458ms)
ℹ tests 2  ℹ pass 0  ℹ fail 2
```

The first failed with `AssertionError: smoke printed no SMOKE_SUMMARY line`, and its captured
stdout is the precise statement of the problem — the old smoke, run with `HOME` pointed at an empty
temp directory, still reached the **real** host SDK and the **real** attached devices:

```
=== validate_toolchain [ok] ===
{ "toolsRoot": "/Users/sushantsrikrish/Library/PICO/sdk",
  "toolsRootSource": "PICO_HOME",
  … "selected": "6.1", "spatialbundleVersion": "6.1.0.0-rls.25",
  "adb": "/opt/homebrew/bin/adb",
=== emulator_list [ok] ===
{ "adbDevices": [ "2G0YC5ZF7Z056Q\tdevice", "emulator-5554\tdevice" ] }
=== inspect_bundle (existing claimsight bundle) [FAIL] ===
No such file: …/empty-home/AndroidStudioProjects/claimsight/editor-asset/build/spatial/bundle/editor-asset.bundle
=== pack_bundle (claimsight scenes -> /tmp) [FAIL] ===
spatialbundle pack failed (exit 19, bundle missing).
Command: /Users/sushantsrikrish/Library/PICO/sdk/6.1/editor/spatialbundle/spatialbundle pack -s …/empty-home/AndroidStudioProjects/claimsight/…
=== inspect_bundle (freshly packed) [FAIL] ===
=== scene_schemas (first 1k chars) [FAIL] ===
```

That is the expected Claimsight/host-probe failure, preserved: a hardcoded personal checkout with
no existence guard, a real `spatialbundle` binary executed, and a real hardware serial enumerated.

**Intermediate RED** — after rewriting smoke, the first test went green and the second still failed
on the one thing not yet done:

```
✔ default smoke reports the same checks and outcomes … (1950.390292ms)
✖ default smoke cannot select host tooling … : CI must not carry an escape hatch for the smoke gate
```

**GREEN** — `node --test test/smoke-isolation.mjs` → 2/2 after `SMOKE_SDK_OPTIONAL` was removed from
`gates.yml`.

The same order was used for `test/sdk-integration.mjs`: the `parseIntegrationArgs([])` assertion and
the README/CI assertions were written before the parser and before the README section existed, and
both failed first (`ERR_MODULE_NOT_FOUND`, then `README must carry the explicit run command`).

---

## Two bugs the run-mode flow exercise found

The brief forbids running the integration against a real project, so I exercised `run` mode against
**fixture inputs only**: a temp `<Name>.spatialproject` directory, a temp bundle file, `PICO_HOME`
pointed at the fixture's empty tools root, and PATH prefixed with the fixture bin (so `adb`
resolves to the refusing stand-in). No real project, no device, no packer. It found two real
defects that fixtures alone had not:

1. **A missing payload was classified `fail`, not `skipped`.** `scene_schemas` and
   `xr_grpc_describe` were run unconditionally and returned
   `No spatialbundle binary found under …` / `No emulator payload found under …`, which
   `classifyToolOutcome` correctly called a failure. But absence of optional tooling must be a
   labeled skip. Fixed by adding the `emulator-payload-available` prerequisite and gating those two
   steps on their respective payloads. The same fixture run now ends `5 pass, 0 fail, 7 skipped`
   instead of `5 pass, 2 fail, 4 skipped`.
2. **A refused `--output` had its report overwritten.** The writer was guarded by
   `fs.existsSync(args.outputDir)`, which is *true* precisely in the EEXIST case — so the run that
   refused to touch prior evidence then wrote `integration-report.json` over it. Fixed with
   `createdOutputDirectory(records)`; verified by writing a sentinel into an existing output
   directory and confirming the refused run leaves the bytes intact.

A blocked run's silent omission of the seven downstream steps was a third, smaller finding, closed
by `blockedStepRecords`.

---

## Tests and results (all host-executed in this worktree)

| Command | Result |
| --- | --- |
| `npm run build` | `published 182 file(s) for source 209366c3ebda` |
| `node --test test/smoke-isolation.mjs` | **2 pass / 0 fail** (was 0/2 at base) |
| `npm run smoke` | **Failures: 0**, exit 0 — 10 checks, all `ok` |
| `node --test test/buildrun-smoke-fixture.mjs test/gate-inventory.mjs test/run-battery.mjs` | **55 pass / 0 fail** (was 53; +2 new fixture tests) |
| `npm run test:lint` | **Failures: 0**; 42 pass / 0 fail |
| `npm run test:distribution-adoption` | **43 pass / 0 fail** |
| `npm run test:docsmeta` | **Failures: 0** (162 links, `sync-metadata --check` clean) |
| `node --test test/sdk-integration.mjs` | **7 pass / 0 fail** |
| `npm run test:sdk-integration`, `npm run test:smoke-isolation` | exit 0 through the run-gate dispatcher |
| `npm run test:picocli-win` (Windows lane content, run here) | **113 pass / 0 fail** |
| `npm run test:tarball` | exit 0 |
| `git diff --check` | clean |

`test:lint` now prints:
`ok published gate-battery size agrees across scripts/gate-inventory.mjs, package.json, gates.yml, README.md, and docs/COLLABORATORS.md (53 invocations / 52 test: suites; linux 50, windows 1, macos 2)`.

### The smoke fixture log, verbatim from a passing run

```json
"calls":[
 {"kind":"fixture-gradle","serial":null,"argv":["assembleDebug","--console=plain"]},
 {"kind":"fixture-adb","serial":"fixture-serial","argv":["-s","fixture-serial","install","-r",".../app-debug.apk"]},
 {"kind":"fixture-adb","serial":"fixture-serial","argv":["-s","fixture-serial","shell","am","force-stop","com.example.contractfixture"]},
 {"kind":"fixture-adb","serial":"fixture-serial","argv":["-s","fixture-serial","logcat","-c"]},
 {"kind":"fixture-adb","serial":"fixture-serial","argv":["-s","fixture-serial","shell","monkey","-p","com.example.contractfixture",…]},
 {"kind":"fixture-adb","serial":"fixture-serial","argv":["-s","fixture-serial","shell","pidof","com.example.contractfixture"]},
 {"kind":"fixture-adb","serial":"fixture-serial","argv":["-s","fixture-serial","logcat","--pid","4242","-d"]},
 {"kind":"fixture-adb","serial":"fixture-serial","argv":["-s","fixture-serial","logcat","-d"]},
 {"kind":"fixture-adb","serial":"fixture-serial","argv":["-s","fixture-serial","shell","pidof","com.example.contractfixture"]},
 {"kind":"fixture-adb","serial":"fixture-serial","argv":["-s","fixture-serial","exec-out","screencap","-p"]}],
"probes":[{"kind":"fixture-adb-probe","serial":null,"argv":["version"]}],
"refused":[{"kind":"fixture-adb-refused","serial":null,"argv":["devices"]}],
"npmCalls":[]
```

Ten device/build operations, all `fixture-serial` or Gradle; one version probe; `preflight_env`'s
`adb devices` **refused**; no npm. Compare the RED run's real `emulator-5554` + `2G0YC5ZF7Z056Q`.

### The documented integration command and its mutations

```bash
node test/sdk-integration.mjs run \
  --project /absolute/path/to/ProjectDir \
  --bundle  /absolute/path/to/existing.bundle \
  --output  /absolute/path/to/new-run-dir
```

Creates `--output` (only that directory), writing `integration.bundle` + `integration-report.json`
there. Reads `--project` and `--bundle`. Refuses an existing `--output`. Installs and launches
nothing. **Not executed against any real project in this task**, and not executed against the
paused Mission Replay checkout or the Claimsight checkout.

Fixture-only flow evidence (labeled: not an SDK integration result):

```
pass    project-readable / bundle-readable / output-fresh
skipped spatialbundle-available — no spatialbundle payload under …/pico-home; scene-schema and bundle steps cannot run
skipped emulator-payload-available — no emulator payload under …/pico-home; proto discovery cannot run
pass    validate_toolchain / emulator_list
skipped xr_grpc_describe / scene_schemas / inspect_bundle-supplied / pack_bundle / inspect_bundle-packed
SDK integration pass: 5 pass, 0 fail, 7 skipped
```

and the refusal path, with a sentinel proving prior evidence survived:

```
fail    output-fresh — --output already exists; choose a new directory so prior evidence is preserved: …/run-1
skipped validate_toolchain … inspect_bundle-packed — not attempted: output-fresh failed
SDK integration fail: 4 pass, 1 fail, 7 skipped
prior bytes: sentinel
```

---

## Decisions inside the brief's latitude

1. **`test:smoke-isolation` and `test:sdk-integration` are Linux-only.** The resolution allowed the
   Windows lane "only if it passes there by construction". `test:smoke-isolation` spawns
   `test/smoke.mjs`, which on `win32` takes the `executesMcpSuccessPath === false` branch — so the
   Windows run would compare two check lists in which the load-bearing check is a SKIP and the
   fixture log is empty, making both brief assertions vacuously true. That is a weaker gate wearing
   the same name, and I have no Windows host to confirm even that. I kept both on Linux and am
   saying so rather than guessing. `test:picocli-win` still resolves to the identical three-suite
   command and its content passes here (113 tests), including the two new helper tests.
2. **`test:sdk-integration` is the unit suite; the host run is never a gate.** Exactly resolution 3's
   preferred shape. `test/sdk-integration.mjs`'s own test asserts the package script is the
   dispatcher and that `gates.yml` never contains `sdk-integration.mjs run`.
3. **`AGENTS.md`'s smoke gotcha was rewritten, not just re-counted.** My boundary said "derived count
   lines only". My change falsifies both halves of that paragraph ("is not hermetic", "CI is green
   only because gates.yml sets SMOKE_SDK_OPTIONAL=1") and removes the env var it names, so leaving
   it would have left a knowingly-false gotcha *and* the last `SMOKE_SDK_OPTIONAL` reference outside
   historical docs. This is the one edit here a reviewer may want to revert; it is outside the
   policy markers and uses none of the guarded policy vocabulary (`git diff README.md AGENTS.md |
   grep -ciE "managed-latest|PICO_MCP_CLI|registry-latest|pico-mcp-managed-cli-policy"` → `0`).
4. **`adb version` is answered, `adb devices` is refused.** See *What I implemented*. The
   alternative — a fixture adb reporting a device — would push `preflight_env` into
   `nc -z 127.0.0.1 8554`, a real probe of the localhost port a real emulator serves gRPC on.
5. **The fixture PATH is a fixed system list, not the host's.** It makes smoke's outcome identical
   across machines rather than merely "the fixture wins the lookup", and is documented with the
   constraint it implies (no bare `node` spawn).

---

## Self-review

- **Completeness.** Every brief checkbox: fixture invocation log on the fake Gradle/adb plus a fake
  npm that rejects calls, with the brief's three assertions used verbatim ✓; RED preserved, showing
  the real Claimsight/host probe ✓; Claimsight constants, `SMOKE_SDK_OPTIONAL` and the error-text
  regex removed, registration/output-schema/pure-tool checks and the fake build success path kept ✓;
  the four SDK-dependent lanes moved to explicit integration ✓; fixture `PICO_HOME` + fixture serial
  reused, startup and pure-tool checks asserted to make no npm call, the user's home variables and
  CLI policy untouched (the server's env is built, not the user's changed) ✓; prerequisites checked
  before invocation with explicit pass/fail/skipped records and reasons ✓; CI escape hatch removed ✓;
  integration command and mutations documented, never executed against Mission Replay ✓; commit
  subject exact ✓. Every resolution 1–5 followed.
- **Discipline / boundaries.** `git show --stat` lists 11 files, all inside my ownership. `src/**`,
  `scripts/build-*.mjs`, `scripts/plugin-bootstrap.mjs`, `scripts/run-gate.mjs`,
  `scripts/run-battery.mjs`, `scripts/verify-tarball.mjs`, `test/docsmeta.mjs` untouched.
  `test/lint.mjs` and `test/distribution-adoption.mjs` needed **no** change — both already derive
  from `GATES`, which is the R3 mechanism working as intended. No policy block byte changed.
- **Quality.** One responsibility per file: hermetic gate / isolation proof / explicit host lane /
  fixture programs. Every non-obvious choice carries a why-comment (the probe-vs-refusal split, the
  baked-in log paths, the excluded Node directory, the non-recursive mkdir, the report-write guard).
  Node 20 APIs only. Assertions use `includes()` where a regex would have dumped a whole file as the
  diff.
- **Testing.** Real server spawns against fixtures (smoke twice per isolation run, plus the two
  negative build_and_run tests); the fixture adb's refusal behaviour is unit-tested by spawning it
  directly and asserting the exact log kinds; the env builder is asserted to contain no path under
  `os.homedir()`. Output is pristine (`Failures: 0`) and every gate exits promptly.
- **Verification of the stated invariant.** No path in default smoke can reach: a **real device**
  (fixture adb refuses every untargeted command and every foreign serial; the log proves it),
  the **registry** or **npm** (policy `disabled` *and* a poisoned npm; `npmCalls.length === 0`),
  **setup** (no CLI path exists under `disabled`), a **real packer** (no pack call remains, and
  `PICO_HOME` holds no version directory), or a **personal checkout** (no `os.homedir()`, no
  `process.env`, no `AndroidStudioProjects` in the file). `git grep -n claimsight test/ scripts/
  .github/` returns only the five pre-existing hits in `test/boundaryexperiment.mjs` (fictional
  `com.example.claimsight` package identifiers) and `test/projectgen.mjs` (a residue blocklist) —
  nothing new, and `test/smoke.mjs`'s three hits are gone.

---

## Concerns

1. **`test:smoke-isolation` runs the full smoke twice, and CI runs smoke a third time.** ~2 s per
   smoke here, so ~6 s added to the Linux lane on this host; on a cold CI runner each server spawn
   is slower. If the lane's 20-minute budget ever tightens, this is the obvious thing to look at —
   but the duplication is the point of the gate, so I did not try to share a run.
2. **The two new gates are Linux-only and Windows smoke remains unproven.** Decision 1 above. If a
   Windows host becomes available, the open question is whether `test/smoke.mjs` should assert
   something stronger than a SKIP there before `test:smoke-isolation` is added to that lane.
3. **`runIntegration` is exercised only against fixtures.** Its prerequisite, classification,
   blocked-run and report-write paths are all covered (and two bugs were found that way), but the
   branch that actually packs a bundle with a real `spatialbundle` has not run in this task, by
   instruction. `pack_bundle`'s `sceneDir` is assumed to be `<project>/Sources/Scenes`, matching the
   layout the old smoke used; a project laid out differently would fail rather than skip, which is
   the correct classification but may surprise.
4. **`preflight_env` still probes the host for things the fixture does not control** — `df` for free
   space, `/usr/libexec/java_home` for a JDK, `magick` on PATH. These change its *internal* check
   details between machines, but not smoke's check list or outcomes, which is what
   `test:smoke-isolation` compares. If a future change made smoke assert on preflight's individual
   checks, that assertion would not be hermetic.
5. **`docs/superpowers/plans/*` and `docs/findings/*` still print `SMOKE_SDK_OPTIONAL=1 node
   scripts/run-battery.mjs`.** Left untouched as dated evidence, per the preserve-evidence
   constraint; anyone copying those lines now sets an env var nothing reads.

---

# Fix round 1

**Commit:** `62ef21a` — `test: report no SDK evidence when integration steps skip and vary PICO_HOME in the isolation proof` (not pushed)
**Base:** `13c93ad`
**Files:** `test/sdk-integration.mjs`, `test/smoke-isolation.mjs`, `test/smoke.mjs`, `AGENTS.md`. No other ledgered item touched.

## 1. The run-level aggregate reported success for a run with no SDK evidence — accepted, fixed

The reviewer is right, and it is the same class of over-claim this repo exists to prevent:
`evidence: counts.pass > 0 && counts.fail === 0` was satisfied by the *prerequisites* alone, so a
host with neither payload skipped all seven `INTEGRATION_STEPS` and still persisted
`evidence: true` into `integration-report.json`.

`summarizeIntegration` now returns three separate facts, with the doc comment saying why they are
separate:

```js
const noFailures = counts.fail === 0;
const evidence = noFailures
  && INTEGRATION_STEPS.every((step) => records.find((entry) => entry.check === step)?.status === "pass");
return { status: noFailures ? "pass" : "fail", counts, noFailures, evidence };
```

The final line appends `— no SDK evidence produced` whenever `evidence` is false (which covers the
failing case too, where it is equally true and equally worth saying).

**Measured, on a fixture project with an empty fixture tools root** — no real project, no device,
no packer:

```
SDK integration pass: 5 pass, 0 fail, 7 skipped — no SDK evidence produced
integration-report.json summary:
{"status":"pass","counts":{"pass":5,"fail":0,"skipped":7},"noFailures":true,"evidence":false}
```

and the blocked case:

```
SDK integration fail: 4 pass, 1 fail, 7 skipped — no SDK evidence produced      exit=1, 0.03s
```

**Tests.** The pinned assertions at the old `:378-380` were updated to the new shape — including
the one that had encoded the bug (`{pass, skipped}` → `evidence: true`), now `evidence: false` with
the comment naming it as the shape the old aggregate got wrong. A new test,
*"a run that exercised no SDK step reports no evidence, however few things failed"*, covers four
cases: all seven steps skipped (`status: "pass"`, `noFailures: true`, `evidence: false`,
`counts {pass:3, fail:0, skipped:9}`); one step short of a full run (`evidence: false`); every step
passed (`evidence: true`); and a blocked run through `blockedStepRecords` (`fail`, no evidence).

**Deliberately not changed:** the exit code is still 0 when nothing failed. The reviewer's
prescription and the controller's guidance both specify the `evidence` field, the `noFailures`
field and the wording; the exit code is the answer to "did anything break", the report is the
answer to "was anything proved", and this script is explicitly never a gate. Flagging it as the one
part of finding 1 I did not change, in case the intent was broader.

## 2. The isolation proof's blind spot, and the AGENTS.md absolute — accepted, fixed, and measured

Both halves done.

`runSmoke` now builds the child environment through an exported `smokeChildEnv(home, extra)` that
strips `^(?:PICO_|ANDROID_)|^JAVA_HOME$` from `process.env`, and the decoy run passes
`PICO_HOME` pointing at the decoy SDK root:

```js
const empty = runSmoke(emptyHome(root));
// The second run varies BOTH axes: a different home, and a PICO_HOME naming the decoy SDK.
const decoy = runSmoke(decoyTree.home, { PICO_HOME: decoyTree.toolsRoot });
```

`decoyHome` now returns `{home, toolsRoot}`, and the test first asserts the decoy tools root really
holds a `0.13` version directory — otherwise a leak would resolve nothing and the axis would be
decorative. A third test pins the env contract directly: only an explicitly passed `PICO_HOME`
survives, and with nothing passed the child inherits no toolchain variable at all.

**Two mutations, run against the real gate,** because the AGENTS.md sentence had to be replaced
with something I had measured rather than something else I assumed:

| Mutation of `test/smoke.mjs` | Result |
| --- | --- |
| `{ ...buildRunSmokeFixtureEnv(fixture), ...process.env }` (the reviewer's regression) | **2 of 3 fail** — the behavioural comparison (`empty host home: smoke exited 1`, the host adb cannot serve `fixture-serial`) *and* the source assertion (`smoke must build the server's environment explicitly, never spread the caller's`) |
| `{ ...buildRunSmokeFixtureEnv(fixture), PICO_HOME: process.env.PICO_HOME ?? fixture.picoHome }` (tools-root only) | **1 of 3 fails** — the source assertion only; the behavioural comparison stays green |

The second row is the honest limit: no check smoke retains reads the toolchain, so a leak confined
to the tools root changes no outcome and trips no tripwire. Varying `PICO_HOME` closes the reviewer's
scenario (both runs can no longer resolve the *same* real root) but does not by itself make the
behavioural comparison sensitive to a tools-root leak — the source assertion is what catches that.
`AGENTS.md:41-49` now says exactly this, enumerating what each half enforces, with no absolute:

> A leak that changes an outcome (a host PATH, a host home) fails the first; a leak that changes
> only the tools root is caught by the second, because no retained check reads the toolchain.

Mutations were reverted from a pre-mutation copy; `grep -c "process.env" test/smoke.mjs` → `0`, and
`git diff test/smoke.mjs` shows only the item-3 change.

## 3. `process.exit` could truncate the parsed line — accepted, fixed

`test/smoke.mjs` and `runIntegration` both set `process.exitCode` and let the loop drain, each with
an inline comment naming the reason. Every client is closed before that point, so neither hangs:
smoke `1.06s total`, exit 0, `SMOKE_SUMMARY` present and complete; the integration failure path
`0.03s total`, exit 1.

## Fix-round tests and results

| Command | Result |
| --- | --- |
| `npm run build` | `published 182 file(s) for source 209366c3ebda` |
| `node --test test/smoke-isolation.mjs test/sdk-integration.mjs` | **11 pass / 0 fail** (was 9; +1 aggregate test, +1 env-contract test) |
| `npm run smoke` | exit 0, Failures: 0 |
| `npm run test:lint` | exit 0 |
| `npm run test:distribution-adoption` | exit 0 |
| `npm run test:docsmeta` | exit 0 |
| `npm run test:smoke-isolation`, `npm run test:sdk-integration` | exit 0 through the dispatcher |
| mutation 1 (`...process.env`) | gate **fails**, 2 of 3 tests |
| mutation 2 (tools-root only) | gate **fails**, 1 of 3 tests (source assertion) |
| fixture integration run, bare tools root | `pass: 5 pass, 0 fail, 7 skipped — no SDK evidence produced`; report `evidence:false` |
| `git status --short` | clean |

## Notes

- Original concerns 1–5 stand unchanged. Concern 4 is now partly documented in `AGENTS.md` itself:
  the fact that no retained smoke check reads the toolchain is what bounds the behavioural half of
  the isolation proof, and it is written down rather than left to be rediscovered.
- New, small: `summarizeIntegration`'s `status` is now explicitly documented as "nothing broke", not
  "the toolchain was exercised". Any future consumer that wants the latter must read `evidence`.
