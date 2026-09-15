# CLI 0.5 / SDK 6.1 compatibility checkpoint — 38.0.0

What was changed, what was actually proved, and what is still open. Companion:
[CLI050_CAPABILITY_MATRIX.md](CLI050_CAPABILITY_MATRIX.md) — the routing decision for every
capability pico-cli 0.5 added. Plan: [2026-09-15-cli050-sdk61-evolution.md](../superpowers/plans/2026-09-15-cli050-sdk61-evolution.md);
spec: [CLI_050_SDK61_EVOLUTION_HANDOFF_2026-09-15.md](../CLI_050_SDK61_EVOLUTION_HANDOFF_2026-09-15.md).

**This is a compatibility checkpoint, not an acceptance.** Nineteen tasks made this server's CLI
routes, SDK selection and release machinery correct against pico-cli 0.5 and Spatial SDK 6.1 *as
declared*. No 0.5.0 command ran through this host's managed CLI, no emulator or device was used for
verification, and **no frame was captured as evidence or looked at; the only frames produced were
the accidental RED-run captures recorded under Negative evidence, neither inspected nor retained**.
The strongest evidence class earned anywhere in this checkpoint is `host-executed`.

Where a claim's strength is not obvious it is labelled with its evidence class, and the sections
that exist to state strength — the class table below, the capability matrix, the battery results,
the distributable and the open items — label every row. Two sections are deliberately unlabelled
because a uniform label would add noise rather than precision: the "Why 38.0.0" list and the
per-task before/after table are **`source-inspected` throughout**, describing changes as the code
and commits show them, and neither asserts anything about runtime behavior.

## Evidence classes

| Class | Meaning | Earned here |
|---|---|---|
| `source-inspected` | Read from the official package's own JavaScript, in memory, from retained tarballs. | yes |
| `help-observed` | A bounded `--help` ran; its bytes are retained with sha256 and cited by invocation number. | yes (from the audit; not re-run here) |
| `fixture-tested` | Exercised through production code paths against injected inputs or fake children. | yes — the bulk of it |
| `host-executed` | Really ran on this macOS host; result recorded. | yes — builds, the gate battery, the distributable |
| `native/visual` | A rendered frame was captured and looked at. | **none** |

## Identity

| | |
|---|---|
| Base commit | `4478238` (audit/plan checkpoint; `origin/main` is `308c898` and nothing has been pushed) |
| Integration head before this task | `c40180b` — all three tracks + I1 + C6 merged |
| Branch / worktree | `cli050-sdk61-evolution-2026-09-15` in `.worktrees/cli050-sdk61-evolution-2026-09-15` |
| Release version | **38.0.0** (was 37.0.0) |
| Source files | 190 `src/*.ts` (182 at base) |
| Fix-wave content head | `1a22709` (six `fix:`/`docs:` commits on `8ef62e4`; the evidence commit that records this table follows it) |
| Build receipt input sha256 (source identity), final tree | `eb105535d1378282c4fbaf15c8f111761451173cc8d8e209f52b0c5300654a1c` (F1's `e51cb8f1b72bfdde1b7f4b0b7927b4db8f8184f899e7c7cfaf21471307cbca3f` is the pre-fix-wave value, superseded) |
| Build receipt output sha256, final tree | `5d245218bf71c550eda5a2c8048b3938a96eeffeee71f383f361188c762a6d94` (F1's `68a3d0a73884eb5bb57c6a906600e443c56922b2a34dfae29bb434a97eabd7ce` superseded) |
| Build published | 190 `dist/*.js` + `dist/build-receipt.json` |
| Toolchain | Node `v25.8.1`, TypeScript `5.9.3`, macOS (`darwin-arm64`) |
| Baseline identity record | `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/IDENTITY_BASELINE_001.json` (`host-executed`) |

All of it is `host-executed`.

## Why 38.0.0 and not 37.1.0

Under this repository's own convention (36.x → 37.0.0 was a major for the managed-latest default),
these are compatibility-affecting behavior changes, and hosts install by version:

- Knowledge argv is version-dependent: `mcp dev-knowledge` → `knowledge server` on 0.5.x.
- `watch_crash`'s `watchedSec` is now the **observed** window, not the requested one, plus new
  `observation`/`coverage`/`assessment` fields.
- `perf_diagnose` dispatches `perf live run` with a new result shape and measurement/capability
  semantics.
- Doors forward inner errors with `isError: true`; `pico_look` reports a capture failure as an error
  instead of `{status:"ok"}`.
- `scaffold_spatial_app` refuses without a usable packer.
- An explicit `PICO_ADB` that names no file **fails closed** instead of being silently ignored.
- `verify_pico_apk` / `pico_verify_app`, `capture_frame`, `capture_record` and (this task)
  `watch_crash` require an explicit target; there is no default serial. Since the fix wave the
  target is required in the **input schema** of `watch_crash`, `verify_pico_apk` and
  `capture_record`, so a client that omits it gets a protocol validation error rather than a
  typed refusal.
- `install_editor_palette` selects the editor bundle it modifies through the toolchain selection
  (fix wave) instead of re-signing a hardcoded `~/Library/PICO/sdk/0.13` bundle; an explicit
  `editorApp` still wins.
- The build script, smoke, `--publish` semantics and the gate inventory all changed, and (fix
  wave) every `fixture`/`installed-artifact` gate child runs under `PICO_ADB=/fixture/no/such/adb`
  unless the caller set one.

A major is the conservative signal. The word "validated" is deliberately absent from the release
commit subject: fixture gates do not validate native behavior.

## What each task changed

One row per task, with its commits and the before/after that matters. Full reports live beside the
plan ledger (`.superpowers/sdd/2026-09-15-cli050-sdk61-evolution/task-*-report.md`, untracked
controller scratch).

### Release track (R1–R6) — build, dependency and gate integrity

| Task | Commits | Before → after |
|---|---|---|
| R1 | `bfc123e`, `2fe9ea6`, `737398d`, `7f9a304` | `dist/` accumulated orphans from deleted sources and nothing bound output to input → builds publish wholesale through a staging rename, emit `dist/build-receipt.json` binding source identity to output, and an interrupted build kills its compiler child and cleans its own scratch instead of wedging later builds for 30 s. |
| R2 | `9f57e37`, `685e8d9` | A host plugin cache could serve a stale server forever → bootstrap compares source and dependency identity and rebuilds; npm's own hidden lockfile is accepted as dependency evidence so an offline checkout is not forced through `npm ci`. |
| R3 | `22c2740`, `f8c78c7` | Gate commands were duplicated across `package.json` and `gates.yml`, and `test:runrevision` ran in no lane → one inventory (`scripts/gate-inventory.mjs`) owns every gate command and its CI lane; `run-gate` refuses a gate whose `dist/` is stale; published counts are derived, not typed. |
| R4 | `13c93ad`, `62ef21a` | `npm run smoke` reached the real host SDK and a personal checkout → smoke builds its whole environment (empty tools root, fixture home, fake `adb`/Gradle, refusing `npm`); `test:smoke-isolation` proves it twice, and the real-SDK lane is a separate non-gate command that says "no SDK evidence produced" unless every step ran. |
| R5 | `91a81a0`, `ff50473`, `ff5fa8d` | The docs gate scanned a different file set locally than in CI and would read a document symlinked outside the checkout → selection goes through `git ls-files` and document paths are containment-checked before being read. |
| R6 | `ad3e1d6` | Publication could replace a prior verified artifact → `--publish` is non-replacing; a re-publish to an existing name is refused, and the receipt is written beside the artifact. |

### CLI track (C1–C6) — pico-cli 0.5 routes and observation honesty

| Task | Commits | Before → after |
|---|---|---|
| C1 | `8aed3b2`, `9257bfd`, `01b009a`, `d938c74`, `c977ef0` | Routes were hardcoded and version-blind → `src/clicapabilities.ts` classifies each operation from **retained bounded `--help` evidence bound to the exact resolved executable**, per package version; an unproven shape is `unknown`, never `unavailable`. |
| C2 | `91022f0`, `f743b0b` | The knowledge child launched `mcp dev-knowledge`, which **0.5.x removed** → argv is selected per resolved version. Matrix fact: the 0.5.0 knowledge server execs an external `graphify serve`, so the published package ships only the degraded no-graph server; that is reported as the server's own data gap, not an MCP failure. |
| C3 | `81970cc`, `1b38dad` | `watchedSec` reported the **requested** window, so a watchdog kill looked like a clean quiet window → it is the observed elapsed time from a monotonic clock, with `observation.coverage` (complete/partial/unknown) and an `assessment` that only says `no-crash-detected` on complete coverage **and** a complete log scan. |
| C4 | `f41fb8e`, `a57f438`, `9726a84` | `perf_diagnose` invoked `perf monitor run`, which the 0.5.0 router rejects → it dispatches `perf live run` from capability evidence with option spellings read from the vendored profiler's own declarations, and a SKIP/INSUFFICIENT_DATA report grades `missing` — never a passing budget. |
| C5 | `f401f21`, `558e19b`, `12afdfd` | Twenty concurrent first door calls started **twenty** inner servers, and an inner error was rewrapped as `{status:"ok"}` → one single-flight inner client; inner errors are forwarded with `isError: true`. Measured: 20 → 1 inner children, 734 → 296 ms burst (`evidence/2026-09-15-cli050-sdk61-evolution-impl-001/doors-transport/`, `host-executed`, n = 1, not a performance claim). |
| C6 | `10e0372`, `8b7e7a8`, `1d2e23d` | `verify_pico_apk` hardcoded `emulator-5554`, cleared the device's global logcat buffer, and could force-stop a foreign app → it requires an explicit `serial`, force-stops only the package it installs, clears no buffer, and inspects captured media before calling it evidence; `capture_frame`/`capture_record` require an explicit target with run-unique default outputs. |

### SDK track (S1–S6) — 6.1 selection and declaration provenance

| Task | Commits | Before → after |
|---|---|---|
| S1 | `bde4098`, `07e1246` | Tool selection assumed one payload layout → component-aware selection (`packer`, `emulator`, `adb`, `editor`) with structured failure codes. |
| S2 | `7b41699`, `d708fdb` | The doctor and the packers could disagree about which SDK a project uses → one selection per workflow, project-scoped, with explicit provenance when a binary override is honoured. |
| S3 | `524e606` | Scaffolding overwrote a project's declared BOM → project SDK identity is read and preserved; scaffolding refuses structurally without a usable packer. |
| S4 | `675ce0d`, `3c5606a`, `f757f52`, `fd96e03`, `ba09967`, `69f7b48` | An unusable explicit `$PICO_ADB` silently fell through to PATH → it **fails closed** with a structured error naming the rejected override; adb resolves lazily instead of freezing at module load; `local.properties` is parsed with `java.util.Properties` semantics. |
| S5 | `5a8ddd9`, `4ff270f`, `dde0669`, `89ee9d0` | Vault lookups could headline `target-verified` on a partial match → every match must be verified; declaration authority is bound to explicit provenance, and a missing compatibility index reads as `missing`, not as "nothing reviewed". |
| S6 | `30cfb12` | No cross-suite statement of what SDK selection actually proves → `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/sdk61-selection/REVIEW.md`, a structural matrix with explicit UNEXECUTED rows. |

### Integration (I1) and this task (F1)

| Task | Commits | Before → after |
|---|---|---|
| I1 | `f88a7d0`, `af8ce54` | Track suites were unregistered and `data/sdk-compatibility` did not ship → six SDK suites registered as `test:sdkselection`, `cliobservations` and `innerclient` folded into existing gates, `files[]` ships the payload, and the installed-tarball gate gained a payload canary. The packaged compatibility basis is a home-path-redacted derivative with `derivedFrom: {path, sha256, transform}` recorded; the original `docs/SDK_6_0_0_DRIFT.md` is byte-untouched. |
| F1 (this) | see [below](#what-this-task-changed) | Fixture hermeticity, the last defaulted target, gate registration for C6's suites, doc truth, the lock-version guard, 38.0.0, the battery and the distributable. |

## What this task changed

| Area | Change |
|---|---|
| Fixture hermeticity | `test/picocli.mjs`'s `baseIO` and `test/distribution-adoption.mjs`'s emulator-bundle-route fixture now declare `adbOverride` and `javaHomeEnv` instead of inheriting them, so preflight's adb and jdk rows answer from the fixture rather than from this machine. `test/emulator.mjs`'s boot fixture declares `PICO_ADB` pointing at its own fake adb (see the fourth incident below). |
| Explicit targets | `watch_crash` requires `device`, refused **before** any CLI resolution, and `WatchCrashRequest.device` is required at the type level so no code path can substitute one. The parameter keeps its name (see open items). |
| Gate registration | C6's `test/artifactinspection.mjs` and `test/verifyapk-observation.mjs` become one Linux fixture gate `test:observation`. Derived counts move once: **55 gate invocations (54 `test:` suites plus `smoke`), 52 on the Linux lane**. |
| Doc truth | Two rows of `docs/DEVICE_VERIFICATION.md`'s serial-support table corrected against the source at this commit; `AGENTS.md`'s dist-import count re-derived with its own published command (70 of 97, was 68 of 95). No policy bytes changed. |
| Release guard | `test/docsmeta.mjs` now fails when `package-lock.json`'s two version fields disagree with `package.json`. |
| Release metadata | 38.0.0 applied through the guarded `npm version --no-git-tag-version`; `npm run sync:meta` stamped eight manifest sites; `sync-metadata --check` reports zero stale sites. |

### What the fix wave changed (final whole-branch review → FIX1)

The final whole-branch review found no Critical, nine Important and seven Minor items; all
were dispositioned by the controller and implemented in one wave on top of `8ef62e4`. Everything
here is `source-inspected` / `fixture-tested` / `host-executed`; nothing native or visual.

| Item | Change | Commit |
|---|---|---|
| Hermeticity barrier enforced | `FIXTURE_NO_ADB` and `gateChildEnv` in `scripts/gate-inventory.mjs`; `run-gate` applies the literal to every `fixture`/`installed-artifact` child unless the caller set `PICO_ADB` (caller value wins; `native-contract` untouched; `process.env` never written); `gates.yml` carries it at workflow level; seven unit tests through the injected `spawnChild` | `35d6f07` |
| Call-only door fixtures cannot spawn the inner server | `doorCallRaw` refuses with a fixture error naming the missing `callRaw` seam and the two raw-lane doors before any `inner()` call; the mirror case (`dependencies.call` ignored beside `callRaw`) documented in the same comment; `test/doors.mjs` drives `pico_look` and `pico_verify_app` on a call-only server under a stub `PICO_ADB` | `7297f68` |
| Targets required in the schema | `verify_pico_apk.serial` and `capture_record.device` are `z.string()`; handlers keep the whitespace refusal; tests assert the registered schema and the whitespace case; `capture_record`'s description states `status` grades the call and `media` is the separate validation verdict (`unvalidated` = not inspected) — no behavior change | `9b384bb` |
| `install_editor_palette` selects | per-call `resolveOperationToolchain({ required: ["editor"], primary: "editor" })`; an explicit `editorApp` wins as an explicit path; the selection layer's `unavailable/*` failure is returned verbatim; every result discloses the bundle and its provenance; consumer test against an in-memory tree only, never a real bundle | `48aebc9` |
| Knowledge remedy wording; adb scope comment | both `describePicoCliEnvironmentFailure` sites in `src/knowledge.ts` pass `KNOWLEDGE_OPERATION`, so an environment-classed knowledge refusal is no longer worded as a profiler-payload problem; `src/adb.ts` documents that the bundled adb resolves from the host tools root with no project root and that preflight's `adbInspection` agrees | `ba07103` |
| Documentary truth | `AGENTS.md` bootstrap sentence (identity-driven rebuild) and the pin sentence; `.claude/rules/release-invariants.md` (wholesale publication) and `.claude/rules/src-runtime.md` (selection + residual literals); this document's I2/I3/I4/I6/I7 corrections and the log-tracking sentences; `CHANGELOG.md` 38.0.0 section; S6 `REVIEW.md` rows 1 and 8 scoped, with a dated correction | the wave's `docs:` commit |
| Distributable republished from the final tree | see "Step 6 — the distributable" below; F1's artifact left byte-identical and labeled superseded | the wave's evidence commit |

Reviewer items deliberately NOT changed in code (disclosed instead): the `emulator-5554` defaults
of `perf_diagnose`/`pico_perf` and `perf_trace record`, the emulator-family defaults kept by
design, `check_toolchain_updates`'s 0.13 reads, the nine doors that bypass the injection seam, the
`capture_frame` output naming, `[M11]`'s empty `/tmp/pico-render/`, and the duplicate
`gates.yml:166` step — all in the known-gaps table below.

## Exact commands and results

Every command below ran in this worktree with **`PICO_ADB=/fixture/no/such/adb` exported** — a
controller ruling. Since S4, an explicit override that names no file fails closed, so any test that
still reaches a real adb dies loudly instead of touching the emulator. A failure under the pin is a
hermeticity finding to fix in the fixture, never a reason to unpin.

### Step 1 — fixtures and the last defaulted target

```
npm run test:distribution-adoption      41 pass / 2 fail  (RED, before the fixes)
npm run build                           published 190 file(s)
npm run test:distribution-adoption      43 pass / 0 fail
npm run test:picocli                    exit 0  (157 + 21 + picocli.mjs)
node --test test/cliobservations.mjs    21 pass / 0 fail
```

The two RED failures were exactly the two the brief named:

```
✖ setup-required wrapper results stay source/freshness-neutral and never execute setup
  registry latest/capture_record: {"status":"failed","failureClass":"runtime",
  "note":"device is required: capture_record names the device the recording came from …"}
  'runtime' !== 'setup-required'

✖ preflight prints the verified emulator-bundle install route but never runs it
  {"name":"emulator","status":"unknown","detail":"cannot check without adb", …}
  'unknown' !== 'fail'
```

### Step 2 — gate registration

```
npm run test:observation                48 pass / 0 fail
node --test test/gate-inventory.mjs     31 pass / 0 fail
npm run test:lint                       exit 0 — "published gate-battery size agrees across
                                        scripts/gate-inventory.mjs, package.json, gates.yml,
                                        README.md, and docs/COLLABORATORS.md
                                        (55 invocations / 54 test: suites; linux 52, windows 1, macos 2)"
npm run test:docsmeta                   exit 0, 26 pass / 0 fail
```

### Step 4 — the lock-version guard, then 38.0.0

RED, with `package-lock.json`'s `packages[""].version` deliberately set to `0.0.0-deliberate-mismatch`
(log retained at `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/docsmeta-lockversion-RED.log`;
tracked — force-added past the repository's `*.log` ignore in commit `8ef62e4`, as the audit
evidence directory's logs are):

```
  ok   package-lock.json version carries version 37.0.0
  FAIL package-lock.json packages[''].version is "0.0.0-deliberate-mismatch" != package.json 37.0.0 —
       run `npm version --no-git-tag-version <version>` rather than editing package.json by hand
Docs/metadata gate done. Failures: 1     EXIT=1
```

The **fixture** was restored, not the production metadata: `package-lock.json` is byte-identical
before and after (sha256 `c67edd00c171cf78c6b17357bd9b4e1b2f1665eaced4165a3117aaab4365602b`).

Then, through the plan's guarded command (`npmLaunch` + `PICO_MCP_RELEASE_VERSION=38.0.0`):

```
node --input-type=module <<'NODE' … npmLaunch(['version','--no-git-tag-version','38.0.0']) … NODE
                                        v38.0.0   (exit 0)
npm run sync:meta                       stamped 8 site(s); 0 warning(s)
node scripts/sync-metadata.mjs --check  truth: version=38.0.0  macOS-tools=255  other-host-tools=252  doors=18
                                        --check: 0 stale site(s), 0 warning(s)
npm run build                           published 190 file(s) for source e51cb8f1b72b
npm run test:docsmeta                   exit 0 — both lock fields carry 38.0.0
npm run test:distribution-adoption      43 pass / 0 fail
```

The whole version diff is **the version field and nothing else**: `package.json` (1 field),
`package-lock.json` (`version` and `packages[""].version`), and eight manifest sites —
`plugin.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (metadata + plugin
entry), `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`,
`.cursor-plugin/marketplace.json`, `.agents/plugins/marketplace.json`,
`.github/plugin/marketplace.json` (metadata + plugin entry). `git diff` over the six byte-pinned
policy documents shows **only** the two derived count lines; no policy byte moved.

### Step 5 — the inventory-driven battery

One run, this macOS host, with the pin exported:

```
node scripts/run-battery.mjs "$PWD" \
  "$PWD/evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/battery-38.0.0.log"

PICO gate battery (55 invocations)   host: macos
BATTERY FAIL  52/55 passed; 3 failed:
  test:claims [exit 1], test:emulator-restart [exit 1], test:spatialui-adoption [exit 1]
```

**Zero gates were skipped.** The battery plans by *scope*, not host: every `fixture` and
`installed-artifact` gate runs on any OS, and only a `native-contract` gate assigned to another OS
is skipped. This host is macOS and both native-contract gates are macOS-assigned, so all 55 ran.
The aggregate log is `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/battery-38.0.0.log`
(453 kB; tracked — force-added past the repository's `*.log` ignore in commit `8ef62e4`).

Three gates the brief asked to be inspected **before** running, and what they actually did here:

| Gate | Inspected before running | What happened on this host |
|---|---|---|
| `test:vcamtransport-native` | `scripts/test-cmio-camera-writer.sh` compiles native sources with `xcrun --sdk macosx clang` and targets a synthetic device UID `00000000-…-0001`. It asserts, as a **precondition before any case that could reach a producer**, that the UID matched *zero* CMIO devices — and refuses to continue otherwise. Device-free by construction. | **PASS (2.0 s)** — real compile against the MacOSX 26.5 SDK. Not a skip. |
| `test:vcamreader-native` | `scripts/test-cmio-camera-reader.sh` likewise compiles, uses `--cmio-probe-only` read-only metadata enumeration against an unresolvable UID, and explicitly *skips its readback-block assertion if the reader turns out to be authorized*, "to stay device-free". No camera is opened. | **PASS (1.7 s)** — real compile. Not a skip. |
| `test:provision` | `test/provision.mjs` part 2 bakes with the **real** spatialbundle when a local toolchain is present. Source read first: it writes one procedural USDA into a fresh `fs.mkdtempSync` directory, bakes `gem0.bundle` beside it, and removes the tree. It never touches a user project, a device or the emulator, so it was allowed to run. | **PASS (4.7 s)**, and it really baked: `ok bake smoke: gem0.bundle baked for real (3.4 KB, modelName=gem0)`. This gate is host-toolchain-dependent — on a machine without the SDK it self-SKIPs. |

#### Where the three failures stand now

The battery above is the single recorded run. Each failure was then diagnosed and dispositioned;
only the three affected gates were re-run, not the whole battery.

| Gate | Battery result | Disposition | Current |
|---|---|---|---|
| `test:emulator-restart` | FAIL | Fixture hermeticity finding — the boot fixture now names its own adb | **pass** (690 tests, 0 fail) |
| `test:spatialui-adoption` | FAIL | Change-detection pin re-pinned to C4's reviewed bytes; every semantic assertion kept | **pass** (Failures: 0) |
| `test:claims` | FAIL | **Fail by ruling** — regenerating would publish the paused Mission Replay app's claims | **still red on this host, deliberately** |

#### The three failures, each diagnosed

**1. `test:claims` — FAIL BY RULING. A host-state failure, left red on purpose.**

```
FAIL tracked public claims snapshot is stale against the current effective ledger read
```

`test/claimspage.mjs` compares the tracked `docs/claims/claims.json` against a live regeneration from
`~/.pico-mcp/ledgers`, and its own comment says the assertion is machine-specific: CI clones have no
local ledger corpus and skip it. Measured read-only at this commit:

| | tracked snapshot | live ledger read |
|---|---:|---:|
| apps | 86 | 97 |
| claims | 330 | 764 |

Eleven apps exist only in the live read (`com.example.claimsight`, `com.example.museum`,
`com.example.orreryxr`, four `com.fleet.boundarylab*`/`swanmissiontable` entries,
`com.pico.spatial.sample.welcomespace`, `com.picoagent.missionreplay`, `com.picoagent.simwing`,
`com.xrbootcamp.gallery`); eleven more differ in their rows; none were dropped. The tracked snapshot
was last committed **2026-08-13** (`96c54a3`); the newest local ledger is **2026-09-14**. So this is a
month of maintainer-machine ledger drift, not a regression from this checkpoint.

**Ruled: do not regenerate the claims page.** Regenerating requires the `generate_claims_page` MCP
tool, and — the decisive reason — it would fold **`com.picoagent.missionreplay`**, the explicitly
paused application, into the *public* claims snapshot. `docs/claims/claims.json` is therefore
untouched, and this gate stays red on this host by decision rather than by omission.

Note what the red actually means: **CI is unaffected**, because a clean checkout has no
`~/.pico-mcp/ledgers` and the assertion skips itself. The gate only fails on a machine that owns a
live ledger corpus — and it fails there for every maintainer whose ledgers have moved since the
snapshot was last generated, regardless of what they changed. That is a gate reading host state as
if it were repository state, which is the real defect; it is recorded in the open items as
"make `test:claims` hermetic against a fixture ledger".

**2. `test:emulator-restart` — FAIL under the pin, then FIXED.** A genuine hermeticity finding, and
exactly the class the controller's pin ruling exists to expose.

Three cases in `test/emulator.mjs` failed, all with:

```
Error: $PICO_ADB=/fixture/no/such/adb names no existing file. An explicitly configured adb is never
replaced by a PATH or bundled candidate, so no fallback was attempted …
```

This is **not** a test reaching a real device. `runBootFixture` already ships its own fake `adb` and
puts it first on the child's `PATH`. The defect is that its hermeticity was a property of *PATH
order and the absence of a host variable*: the child spreads `...process.env`, so an inherited
explicit `PICO_ADB` — from a battery run, or from any developer who has one set — defeated the fake
beside it, and S4's (correct) fail-closed rule refused to fall back to it.

Fixed by making the fixture name its own adb: the child env now declares `PICO_ADB: fakeAdb`. Re-run:

```
npm run test:emulator-restart    exit 0   tests 690, pass 689, fail 0 (1 platform skip)
```

**3. `test:spatialui-adoption` — FAIL, then RE-PINNED after review. Now green.**

```
AssertionError: src/spatialbench.ts changed outside this task
  actual   0986672c8cd5425c82211d432a52e6f2485d465be4b77102d1d43546bef49ef0
  expected f131b6c19da12ed2741b1dfd366ce2545cb2f7b5d15963e130b11f0bc33e431e
```

`test/spatialui-adoption.mjs` pins the bytes of two protected files so that adoption work can never
inflate the public benchmark corpus. **C4 (`f41fb8e`) edited `src/spatialbench.ts`** — a notes-string
change on the perf-axis fallback path, correct in itself — and did not update the pin. The gate has
therefore been red since `f41fb8e`, through the CLI merge, I1, C6 and `c40180b`, because no lane ran
it in this session. Finding it is precisely what running the whole inventory is for.

The guard's *substantive* invariants all still hold, which is what decided the disposition. The
sha256 at `test/spatialui-adoption.mjs:17` is a **change-detection** pin inherited from the
historical adoption task; the assertions that carry the actual contract are separate and were
re-checked, unchanged and passing:

- `BENCH_CORE` and `BENCH_MR` membership (`:26–27`) — byte-intact in `src/spatialbench.ts`;
- no `docs-adoption-workbench` reference inside `src/spatialbench.ts` (`:354`) — the assertion that
  actually enforces "a repo-only recipe never inflates the benchmark corpus";
- the second protected file, `briefs/calib.json`, still matches its own pin (`b9b76f5f…`).

So the corpus was not touched; only the change-detector had not been told that C4's edit was
reviewed. **Ruling: re-pin to the reviewed bytes, keep every semantic assertion unchanged.** The pin
is now `0986672c…` with a comment above it citing `f41fb8e` and the C4 review, so the next person to
hit this guard learns why the hash moved rather than re-deriving it.

```
npm run test:spatialui-adoption   exit 0   SpatialUI adoption test done. Failures: 0
npm run test:bench                exit 0   SpatialBench test done. Failures: 0
```

`test:bench` was re-run alongside it because it is the other consumer of the scoring path C4
changed; it is green, so the re-pin recorded a reviewed change rather than papering over a
regression.

The real lesson is about the gate, not the pin: this guard had been red since `f41fb8e` — through
the CLI merge, I1, C6 and `c40180b` — because no lane ran it in this session. Running the whole
inventory once is what surfaced it.



### Step 5b — the fix-wave battery: no export, a tripwire `adb` first on `PATH`

Run on the final tree after the fix-wave commits, deliberately WITHOUT `PICO_ADB` exported
(`printenv PICO_ADB` → unset in the launching shell), with a directory holding an executable `adb`
prepended to `PATH` that appends its argv to `evidence/…/fix-wave/adb-tripwire.marker` and exits 66
(self-tested first: it wrote `adb devices -l` and exited 66; the self-test marker was then deleted).
Any suite that reached an adb through `PATH` would have written that file.

```
PATH="<tripwire dir>:$PATH" node scripts/run-battery.mjs "$PWD" \
  "$PWD/evidence/2026-09-15-cli050-sdk61-evolution-impl-001/fix-wave/battery-38.0.0-fixwave.log"

PICO gate battery (55 invocations)   host: macos
BATTERY FAIL  53/55 passed; 2 failed:
  test:claims [exit 1], test:runrevision [exit 1]
```

- **`adb-tripwire.marker` does not exist** after the run — checked immediately afterwards, again
  after the isolated re-run below, and again after the republish. Negative evidence: no gate child
  reached an adb through `PATH`. Every `fixture`/`installed-artifact` child ran under the run-gate
  default, and the fixtures that name their own adb (`test/emulator.mjs`, `test/doors.mjs`,
  `[M11]`) used theirs.
- **`test:claims` — red by ruling**, unchanged (host-state snapshot drift; not regenerated).
- **`test:runrevision` — red in the battery, green in isolation; a timing margin, not a regression.**
  One case, `concurrent cross-process enrollment cannot cross exact lock namespace or aggregate
  capacity` (`test/runrevision-locks.mjs:2625`), took 18,051 ms and failed with
  `[{"kind":"capacity-result","status":"run-busy","detail":"shared acquisition budget expired behind a live capacity enrollment"},{"kind":"capacity-result","status":"acquired"}]`:
  the second child waited behind the first's live enrollment past `ACQUIRE_BUDGET_MS = 15_000`
  (`src/runlocks.ts:41`). Re-run alone under identical conditions (no export, tripwire on `PATH`):
  `npm run test:runrevision` → 327 / 327 pass, that case in 16,365 ms. A 15 s shared budget inside
  a case whose own wall time is 16–18 s, on a machine that had just written 12,285 residue files
  and was mid-battery. Nothing in the fix wave touches `src/runlocks.ts` or the revision store, and
  the gate child's only env difference is `PICO_ADB`, which the lock path never reads. Left red in
  the recorded battery log and disclosed, not "fixed": widening a concurrency budget to make a gate
  green is not this wave's call. Recorded in the known-gaps table.
- Everything else: 53 passes, **0 skipped** (both native-contract gates really compiled on this
  macOS host, 2.0 s / 1.7 s).

Logs: `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/fix-wave/battery-38.0.0-fixwave.log`
(sha256 `efe7757dea6006326d19c9cbebbbcffda35069bb1ce348b5f198d9a73a151608`; a byte-identical copy
at `…/release/final/battery-38.0.0-fixwave.log`), the runner's own stdout in
`…/fix-wave/battery-38.0.0-fixwave.runner.out`, the isolated re-run in
`…/fix-wave/test-runrevision-rerun.log`, and one log per targeted suite (`…/fix-wave/<gate>.log`,
all twelve green with the export: `test:lint`, `test:docsmeta`, `test:distribution-adoption`,
`test:prompts`, `test:picocli`, `test:observation`, `test:doors`, `test:sdkselection`,
`test:tarball`, `test:knowledge-lifecycle`, `test:buildfreshness`,
`test:plugin-bootstrap-freshness`).

### Step 6 — the distributable

**The final artifact (fix wave, republished from the final tree).** Same non-replacing route,
fresh path; nothing under `release/` was touched.

```
node scripts/verify-tarball.mjs --publish \
  "$PWD/evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/final/pico-spatial-mcp-38.0.0.tgz"

Tarball verification done. Failures: 0        (48 checks, all pass; 14 s)
```

| | |
|---|---|
| Artifact | `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/final/pico-spatial-mcp-38.0.0.tgz` (untracked, `*.tgz`) |
| sha256 | `c08e1a8baf2b850cae5bdd09eb259fab5270645dda3d635eeb1bc7cb51c435f5` |
| Bytes | 2,161,859 |
| Receipt (tracked) | [`final/pico-spatial-mcp-38.0.0.tgz.receipt.json`](../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/final/pico-spatial-mcp-38.0.0.tgz.receipt.json) — 48 checks, all `pass`, 0 skip |
| Packed build receipt binds | source `eb105535d1378282c4fbaf15c8f111761451173cc8d8e209f52b0c5300654a1c` (195 input files) → output `5d245218bf71c550eda5a2c8048b3938a96eeffeee71f383f361188c762a6d94` (190 emitted files), TypeScript 5.9.3, Node major 25 |
| Platform | `darwin/arm64`, Node `v25.8.1` |
| Receipt `limitations` | darwin/arm64 only; no host-plugin discovery; no emulator, device or visual claim |

**The F1 artifact — pre-fix-wave, superseded, byte-identical.** Re-hashed after the fix wave
(`shasum -a 256`): unchanged.

```
node scripts/verify-tarball.mjs --publish \
  "$PWD/evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/pico-spatial-mcp-38.0.0.tgz"

Tarball verification done. Failures: 0
```

| | |
|---|---|
| Artifact | `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/pico-spatial-mcp-38.0.0.tgz` — **pre-fix-wave, superseded, byte-identical** |
| sha256 | `941e402bb2c234c444e31c62c9bc9dc2c69055ac3aeee48c960e870e100f36d6` |
| Bytes | 2,158,783 |
| Receipt (tracked) | [`pico-spatial-mcp-38.0.0.tgz.receipt.json`](../../evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/pico-spatial-mcp-38.0.0.tgz.receipt.json) — 48 checks, all `pass` |
| Packed build receipt binds | source `e51cb8f1b72b` (195 input files) → output `68a3d0a73884` (190 emitted files), TypeScript 5.9.3, Node major 25 |
| Platform | `darwin/arm64`, Node `v25.8.1` |

Both `.tgz` files are untracked (the repository gitignores `*.tgz`); both receipts are tracked and
carry the artifact's hash and byte count, so each archive's identity survives in Git even though
its bytes do not. The two differ because the fix wave changed shipped sources (`src/doors.ts`,
`src/verifyapk.ts`, `src/picoclitools.ts`, `src/editorpalette.ts`, `src/knowledge.ts`,
`src/adb.ts`) and shipped scripts (`scripts/gate-inventory.mjs`, `scripts/run-gate.mjs`).

**Prior archives are untouched.** Re-hashed read-only at the end of this task, against the hashes
published in `evidence/2026-09-15-cli050-sdk61-evolution-audit-001/README.md`:

| Archive | Bytes | sha256 | Matches README |
|---|---:|---|---|
| `picoxr-pico-cli-0.4.4.tgz` | 37,470,411 | `0eabffe9b6a92c9a96fe61ea38f3213b0971216f0db7c4d19f9da46660ba9524` | yes |
| `picoxr-pico-cli-0.5.0.tgz` | 38,104,171 | `a2afe604b3435a83debe1a42706fa4fe0b9e14d026c857873e8fc21f6ac68642` | yes |

#### What the installed artifact actually answered on this host (`host-executed`)

These are `tools/list` and request results from the **installed** copy in a clean `--omit=dev`
install directory, not from this checkout:

| Observation | Result |
|---|---|
| `tools/list`, full surface | **exactly 255 tools for darwin** |
| `tools/list`, default surface (`PICO_MCP_SURFACE` unset) | **18 door tools** — full stays an explicit opt-in |
| Anchor tools | all 43 present |
| Representative door request #1 | 20 concurrent first door calls started **exactly one** inner server (all answered `unavailable`) — the C5 single-flight contract, on the installed artifact |
| Representative door request #2 | installed `pico_look` forwarded the inner screencap failure as `isError`, never as `status: "ok"`; the stub adb recorded 1 invocation with the `exec-out screencap` argv |
| Representative full-surface request | `preflight_env` ran from the installed copy: 14 checks, `status: problems`, and its fixes contain no repo-only commands |
| Shipped SDK payload | reviewed SDK-compatibility payload verified (3 files: index + every referenced record/basis) |
| Leak scan | no absolute home paths in any shipped file; no build droppings |

**Not performed, and therefore not claimed:**

- **No Windows or Linux run.** The 252 figure for Linux and Windows remains *source-derived* from the
  three-tool host-GUI registration delta; no native `tools/list` has ever been measured on either.
  Windows coverage in this checkpoint is the `test:picocli-win` **fixture** gate, which passed here
  (95.3 s) on macOS — it exercises launcher-shim selection, not Windows.
- **No host discovery.** No Claude Code, Codex or Cursor host loaded, expanded or registered these
  plugin manifests. Token replacement in tests is structural coverage only. That remains a separate
  acceptance step: record host + version, plugin/source identity, the expanded command, the startup
  result and the observed tool requests.
- **No emulator, device or frame.** The receipt's own `limitations` block says the same three things.



## Negative evidence — three RED runs reached real hardware, and one of them did damage

These are retained deliberately. Each is quoted from the task report that disclosed it, so the
record cannot soften with retelling. All three share one root cause: **an injected seam protects
nothing during the RED phase, because RED by definition runs against code that does not yet have
the seam.**

### Incident 1 — S4, fix round 1 RED: a real `adb devices -l`

From `task-S4-report.md`, "Negative evidence the checkpoint must retain: round 1's RED run spawned a
real adb":

> While capturing RED for fix round 1 I ran `node --test test/toolchain-cache.mjs` against the
> pre-fix `src/adb.ts`. The consumer-level case called
> `executeLiveCaptureSettled({serial: "emulator-5554", outPath, maxTries: 2, …})` with **no
> injected dependencies**. Against pre-fix code `adbExecutable()` did not refuse the broken
> `$PICO_ADB` — it fell through to PATH/bundled and returned a real adb — so
> `src/observation.ts:768` built the real dependency set and `executeCaptureSettled` ran it:
>
> - `defaultOnlineSerials(adb)` → **`adb devices -l`** (10 s bound) executed against this host's adb
>   server, starting that server if it was not already running;
> - the input named **`emulator-5554`**, the serial this repository reserves for the user, so if that
>   emulator was online the pipeline would then have run `probeDeviceIdentity` (`adb -s emulator-5554
>   shell getprop …`), `adb -s emulator-5554 shell cat /proc/sys/kernel/random/boot_id`, and
>   `adb -s emulator-5554 exec-out screencap -p`, writing a PNG into the test's own `os.tmpdir()`
>   scratch directory.
>
> The run took **1507 ms** where every other case in the file takes under 8 ms, which is how the
> re-reviewer spotted it. The case failed at its `assert.rejects`, so the trailing
> "nothing was captured" assertion never executed — **I cannot claim the pipeline stopped at
> `devices -l`**, and I am not going to imply it did. What is certain from the code path: every
> command reachable there is read-only (`devices -l`, `getprop`, reading `boot_id`, `exec-out
> screencap`); nothing installed, launched, force-stopped, cleared a log buffer, or restarted /
> moved / resized the emulator; the only write was a PNG inside the temp directory the test itself
> created and removed in `t.after`.

The ledger records the same limit: **this checkpoint must not claim the emulator was untouched.**

### Incident 2 — R4 and C5, base RED runs: the real SDK, the real device list, the host scratch frame

R4's RED run of the *old* smoke, under an empty temp `HOME`, still reached the real host SDK, the
real attached devices **and the user's personal project checkout**. From `task-R4-report.md`,
verbatim from the captured stdout:

> ```
> === validate_toolchain [ok] ===
> { "toolsRoot": "/Users/sushantsrikrish/Library/PICO/sdk",
>   "toolsRootSource": "PICO_HOME",
>   … "selected": "6.1", "spatialbundleVersion": "6.1.0.0-rls.25",
>   "adb": "/opt/homebrew/bin/adb",
> === emulator_list [ok] ===
> { "adbDevices": [ "2G0YC5ZF7Z056Q\tdevice", "emulator-5554\tdevice" ] }
> === inspect_bundle (existing claimsight bundle) [FAIL] ===
> No such file: …/empty-home/AndroidStudioProjects/claimsight/editor-asset/build/spatial/bundle/editor-asset.bundle
> === pack_bundle (claimsight scenes -> /tmp) [FAIL] ===
> spatialbundle pack failed (exit 19, bundle missing).
> Command: /Users/sushantsrikrish/Library/PICO/sdk/6.1/editor/spatialbundle/spatialbundle pack -s …/empty-home/AndroidStudioProjects/claimsight/…
> === inspect_bundle (freshly packed) [FAIL] ===
> === scene_schemas (first 1k chars) [FAIL] ===
> ```

R4's own summary of what that run was:

> That is the expected Claimsight/host-probe failure, preserved: **a hardcoded personal checkout with
> no existence guard, a real `spatialbundle` binary executed, and a real hardware serial enumerated.**

Two distinct things happened, and the disposition is different for each:

- **The device listing was read-only.** It named a **physical PICO device (`2G0YC5ZF7Z056Q`)**
  attached to this host alongside the emulator. Nothing was installed, launched or stopped on either.
- **A third-party binary really executed against the user's personal project.** The run spawned the
  host's **real PICO 6.1 packer**
  (`/Users/sushantsrikrish/Library/PICO/sdk/6.1/editor/spatialbundle/spatialbundle pack -s …`)
  with a scenes path under the hardcoded `AndroidStudioProjects/claimsight` checkout — a path smoke
  had no existence guard for and no business touching. It **failed with exit 19 and produced no
  bundle**, so nothing was written there, but that is the outcome of the run rather than a limit the
  test imposed: the binary was invoked and the personal checkout was read.

This is the defect R4 then removed — smoke now builds its whole environment (fixture home, empty
tools root, fake `adb` and Gradle, refusing `npm`) so it cannot select host tooling at all, and the
real-SDK lane became a separate, explicitly-invoked non-gate command taking three absolute paths.

C5's base RED run of `test/doors.mjs`, from `task-C5-report.md`:

> on the pre-C5 adapter `pico_look`, `pico_verify_app` and `pico_emulator` did not go through the
> injection seam at all (`const { call } = await inner()`), so the base run spawned a **real** inner
> server in the test process's real environment and those doors reached the real emulator read-only
> (`capture_canonical` screencap → overwrote the host scratch file `/tmp/pico-render/canonical.png`;
> `emulator_status` getprop; `verify_pico_apk` attempted an install of the nonexistent
> `/tmp/fixture.apk`, which failed without installing/launching anything). … No emulator state was
> changed; the emulator was not restarted, moved or calibrated.

### Incident 3 — C6, RED phase: ~20 irreversible logcat-buffer clears

The worst of the three, and the only one that destroyed state. From `task-C6-report.md`,
"HERMETICITY INCIDENT — a third one happened, in my RED phase. Disclosing it in full":

> **What happened.** The first RED run of `test/verifyapk-observation.mjs` (2026-09-15 ~13:19 local)
> executed against the **pre-C6** `src/verifyapk.ts`. That implementation took no dependencies at
> all: it ignored the `deps` object my test passed and used its own module-level `ADB()` plus the
> hardcoded `SERIAL = "emulator-5554"`. My injected seam was therefore not in the code path, and 20
> test cases each drove the real `adb` against the user's live emulator.
>
> | Command the old code runs | Effect on emulator-5554 |
> |---|---|
> | `install -r <temp fixture.apk>` | the fixture "apk" is a 17-byte text file — the install failed; nothing was installed |
> | `shell am force-stop com.fixture.observed` | no such package; no-op |
> | **`logcat -c`** | **the device's global log buffer was cleared, ~20 times. Real and irreversible.** |
> | `shell am start -n com.fixture.observed/.MainActivity` | no such activity; launch rejected |
> | `exec-out screencap -p` | wrote a 2 235 758-byte frame of the user's emulator to `/tmp/pico-render/verifyapk/com.fixture.observed.png` |
>
> **What did NOT happen, and why I can say so:** no foreign app was force-stopped. The old
> incumbent-recovery block is gated on `launched && !processAlive && fullSpaceBlocked`, and `launched`
> was false for every case … so that block never ran. Nothing was installed. The emulator was not
> restarted, moved, resized or calibrated. No other process was killed. The physical PICO device was
> never addressed (the old code names only `emulator-5554`).
>
> **Containment.** I deleted the stray capture I created … **I cannot restore the cleared log
> buffer — that loss stands.**

The fix — and the reason the pin now exists — is a barrier that does not depend on the
implementation cooperating: the suite pins `PICO_ADB` to a nonexistent path at module scope, and
`src/adb.ts` fails closed on it. The same RED run with the barrier dropped from **57 201 ms to
96 ms** and produced no device contact.

### A fourth finding, from this task — and why the pin ruling was right

Running the whole battery under the pin surfaced one more fixture whose hermeticity was accidental
rather than declared: `test/emulator.mjs`'s boot fixture (see step 5 above). It never reached a real
device — its own fake `adb` was first on `PATH` — but it would have inherited a host `PICO_ADB`, and
"first on PATH" is not a barrier anyone can rely on. It now declares its adb explicitly.

**The rule this leaves behind — enforced since the fix wave (commit `35d6f07`), not remembered:**
`scripts/run-gate.mjs` spawns every `fixture` and `installed-artifact` gate child with
`PICO_ADB=/fixture/no/such/adb` (`FIXTURE_NO_ADB` in `scripts/gate-inventory.mjs`) unless the
caller set one — a caller-set value always wins, `native-contract` gates get no default, and
`process.env` is never written — and `.github/workflows/gates.yml` carries the same literal at
workflow level, which also covers its one raw `node --test test/homeenvironmenthost.mjs` step.
`npm run <gate>` and `node scripts/run-battery.mjs` therefore carry the barrier themselves (the
fix wave's battery ran WITHOUT the export, with a marker-writing tripwire `adb` first on `PATH`,
and the marker was never written — see the fix-wave section). A direct `node --test test/<file>.mjs`
invocation still gets nothing from either and must export it. The rest of the rule stands: treat a
failure under the pin as a fixture finding to repair — never as a reason to unpin — and make a
fixture *name* the tools it uses rather than arranging for the right one to be found.



## Open items — what 38.0.0 does not establish

### Externally blocked (needs hardware, a provisioned payload, or another OS)

| Item | State |
|---|---|
| **Provisioned profiler help** | Never observable here. Every perf `--help` exited at the CLI's utilities gate (0.4.4 invocation 012 exit 1; 0.5.0 invocations 137–141 exit 3), so **no perf or trace route has a retained exit-0 help example on either version line** and `exitZeroHelpObserved:false` stands for all five. Provisioning the payload needs `pico-cli setup`, which this server never runs. |
| **Native sampling** | No profiler ever ran; no report was produced by a real profiler. Both report schemas are declaration-derived. |
| **Real Windows / Linux** | Zero. The published 252 is source-derived from the three-tool host-GUI registration delta. `test:picocli-win` is a fixture gate that runs on any OS. |
| **Host-plugin discovery** | No host loaded these manifests. Needs: host + version, plugin/source identity, expanded command, startup result, observed tool requests. |
| **Emulator LOOK acceptance** | Not performed. Calibration has been stale since the 2026-09-15 boot (calibrated 2026-09-04 vs boot `2026-09-15T08:33:50Z`), and this task deliberately did not calibrate, boot, move or otherwise operate the emulator to make a check green. |
| **Physical device** | Untouched for verification. It appeared once in a read-only device listing (incident 2); nothing was installed, launched or captured on it. |
| **Mission Replay** | Paused, unchanged. Not edited, built, installed or migrated. Its prior native evidence is **not** SDK 6.1 acceptance. |

### Known gaps carried forward by design

| Item | Why it stands |
|---|---|
| `capture_canonical` / `pico_look` keep the `emulator-5554` default and the fixed `/tmp/pico-render/canonical.png` path | Ruled for this checkpoint: `pico_look` is *by design* the emulator LOOK door with no inputs. The mutable canonical path is a known immutability gap — two `pico_look` calls overwrite each other's frame. The ledger's looked-byte hash check still protects claims, because `record_verification` re-captures and demands byte equality. Closing it means giving `pico_look` a target and a run-unique path, i.e. a second breaking change. |
| `capture_record`'s parameter is `device`, not `serial` | Deliberate. `capture_frame`, `verify_pico_apk` and `watch_crash` use `serial`/`device` inconsistently; renaming `capture_record`'s would be a second break in one release for no behavioral gain. Its **requirement** is what changed. |
| `watch_crash`'s numbers are fixture-derived | `watchedSec`, `observation.coverage` and `assessment` are exercised only against fake children and a scripted monotonic clock. **No watch has ever run against a real `pico-cli` line or a real device**, so no observed-vs-requested number here is evidence about CLI behavior. On 0.4.x the CLI's internal bound cannot be set at all, so coverage there is capped at partial/unknown by construction. |
| ~~`verify_pico_apk` and `capture_record` still mark their target optional in the schema while the prose says REQUIRED~~ — **closed in the fix wave** (commit `9b384bb`) | `serial` (`verify_pico_apk`) and `device` (`capture_record`) are now `z.string()`, required in the schema exactly as `watch_crash` is, with each handler's own refusal kept as defense in depth for the empty / whitespace-only string a schema cannot reject; the refusal tests assert the registered schema and the whitespace case. `pico_verify_app` already declared `serial` required and so mirrors the inner contract; no door forwards `capture_record`. Every existing caller in `test/` already passed the target. |
| `perf_diagnose` (and therefore the `pico_perf` door) and `perf_trace record` still default `device` to **`emulator-5554`** | `src/perfcli.ts:74` (`DEFAULT_PERF_DEVICE`) and `:631` (`opts.device ?? DEFAULT_PERF_DEVICE`); `src/perftrace.ts:589` (`device ?? "emulator-5554"`); the `pico_perf` door (`src/doors.ts`, DOOR 7) takes only `packageName` and `durationSec`, so it cannot even name a device. The explicit-target ruling was applied to the four observation tools and `watch_crash`, not to the perf lanes, and the "Why 38.0.0" list above is correctly scoped to the tools that changed — this row exists so nobody reads it as covering perf. Applying the same refusal here is a further contract break with no plan task; deferred to the next surface sweep. **Disclosed, not changed.** |
| Emulator-family tools keep the emulator default **by design** | `docs/DEVICE_VERIFICATION.md` §6 ("Serial support") records the routing, and it is unchanged at 38.0.0: `verify_baseline`, `verify_visual` and `capture_canonical` accept a serial but default to the emulator; `capture_canonical`/`pico_look` are the no-input LOOK door (first row of this table); `logcat`, `assert_logcat`, `app_broadcast` and the basic adb tools resolve the sole connected device when no serial is passed; `screenrecord`, `wait_for_log`, `check_crash` and `ui_dump` accept a serial through the agent-loop adb path. None of these is covered by the explicit-target ruling. |
| Nine doors bypass the injection seam entirely | `pico_scan_world`, `pico_place`, `pico_measure`, `pico_perf`, `pico_sdk`, `pico_doctor`, `pico_capabilities`, `pico_fix` and `pico_next` call `inner()` directly instead of `doorCall`, so `registerDoorTools(server, dependencies)` cannot redirect them and a fixture server that drives one of them spawns the real inner full-surface server. The fix wave (commit `7297f68`) closed the raw lane — `pico_look` and `pico_verify_app` on a call-only fixture now refuse at the seam — which was the reviewed finding; these nine are pre-existing and outside it. Every test that drives them today does so over the real inner transport with `PICO_ADB` pinned to a stub (`test/doors.mjs`'s e2e block, `[M11]`). Next surface sweep. |
| `check_toolchain_updates` (`src/toolchainwatch.ts:22,27`) reads the **0.13** emulator `package.xml` and editor `version` file directly | An informational reporter comparing installed versions against PICO's release feed: it selects nothing and launches nothing, but on a host without a 0.13 payload its "installed" columns are empty rather than the selected 6.1 versions, and on a host with both it reports the legacy ones. Never routed through the S1/S2 selection and covered by no S6 row (corrected in `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/sdk61-selection/REVIEW.md`). Not migrated — no plan task; next surface sweep. |
| `test:runrevision`'s cross-process capacity case runs a 15 s shared budget inside a 16–18 s case | `ACQUIRE_BUDGET_MS = 15_000` (`src/runlocks.ts:41`) bounds how long the second child waits behind a live enrollment; the test (`test/runrevision-locks.mjs:2625`) spends 16–18 s of wall time, so under load the budget expires and the second result is `run-busy` instead of `acquired`/`limit-exceeded`. Red once in the fix-wave battery (18,051 ms), green in isolation under identical conditions (16,365 ms; 327/327). Timing-sensitive, not a regression from anything on this branch. Next sweep: give the test an explicit `deadlineMonotonicMs` sized to what it measures, or decouple the assertion from the shared budget. |
| Residual `0.13` literals in `src/` | 134 matches at the fix wave (`grep -n '0\.13' src/*.ts`), every one enumerated with a disposition in the subsection below. Two are executed paths (`toolchainwatch.ts`, the row above), one is a retained last-candidate path (`preflight.ts` `LEGACY_SDK_ADB`), one is a default vault workspace label (`vault.ts`), one is remedy text (`diagnose.ts`); the rest are version-label examples, provenance references to the 0.13.3 declarations, or numeric coincidences. `install_editor_palette`'s executed path was removed in the fix wave (commit `48aebc9`). |
| `docs/claims/claims.json` was not annotated | Its `attestation` for P21 describes the removed `status=ok`/`processAlive`/`crashed` shape and the logcat clear. The file is **generated** from the trust ledgers by `generate_claims_page`, not hand-maintained, and the attestation is a verbatim historical record. Hand-editing it would rewrite history *and* be overwritten on the next regeneration. It is already a month stale (see `test:claims` above). Correction lands when the page is next regenerated on the ledger-owning machine — and that regeneration must be made with the Mission Replay question settled first. |
| `gates.yml` has one raw step the inventory cannot see | The macOS lane runs `node --test test/homeenvironmenthost.mjs` directly rather than through a named gate, so `AGENTS.md`'s "one inventory owns every gate command" is true of every *named* gate but not of that line — and the same file already runs inside `test:bridge` on the Linux lane, so the macOS step is a duplicate invocation the inventory's duplicate check cannot see. Left as is (disclosed); since the fix wave the workflow-level `env: PICO_ADB` covers that raw step, which `run-gate` cannot. |
| `capture_frame` writes under `~/.pico-mcp/cli/observations/capture-frame/` | Naming only: the frame is an adb observation, not a CLI one, yet it lives under the CLI observation root (`src/capture.ts:18`). Run-unique and immutable as required; the directory name is left alone rather than moving an evidence root in a fix wave. |
| `[M11]` leaves an empty `/tmp/pico-render/` on the host | `scripts/verify-tarball.mjs`'s installed-doors canary drives `pico_look`, whose `capture_canonical` keeps the fixed `/tmp/pico-render/canonical.png` path (first row of this table); the stub adb fails the screencap, so only the empty directory remains. Harmless. The I1 minor that expected this to disappear assumed C6 would move the canonical path; the later ruling kept it, so the premise — not the canary — was wrong. |
| **`test:claims` reads host state as if it were repository state** | Its snapshot-freshness assertion regenerates from `~/.pico-mcp/ledgers`, so it passes in CI (no corpus → self-skip) and fails on any maintainer machine whose ledgers moved since the tracked snapshot was generated — independently of what that maintainer changed. **Open item: make `test:claims` hermetic against a fixture ledger**, so the gate tests the generator and the tracked snapshot rather than the developer's private corpus. Until then it is red on this host by ruling (see the battery section), and `docs/claims/claims.json` stays untouched. |

### Residual `0.13` literals in `src/`

`grep -n '0\.13' src/*.ts` at the fix wave: **134 matches**, every one listed. Dispositions:
**by design** (a label, a last-resort candidate or an example the code is meant to carry);
**informational** (prose naming the SDK revision a fact was read from, or a comment about the
removed fallback — nothing is resolved from it); **not a version** (a numeric coincidence);
**migrate next sweep** (an executed legacy path).

| File | Lines | What the literal is | Disposition |
|---|---|---|---|
| `toolchainwatch.ts` | 22, 27 | executed paths: `~/Library/PICO/sdk/0.13/emulator/package.xml` and `…/0.13/editor/Spatial Editor.app/Contents/MacOS/version` | **migrate next sweep** (known-gaps row above) |
| `toolchainwatch.ts` | 24 | `"0.13.x"` fallback string for an unparseable revision | informational (same reporter) |
| `toolchainwatch.ts` | 88 | comment: `<latest>` lagged `<release>` (0.12.2 vs 0.13.3) | informational |
| `preflight.ts` | 188 | `LEGACY_SDK_ADB`, the pre-selection bundled-adb path kept as the LAST candidate of the doctor's adb row | by design (disclosed under "Legacy adb paths" below; pinned by the S6 preflight test) |
| `preflight.ts` | 269 | the `"legacy 0.13 platform-tools"` source label for that candidate | by design |
| `preflight.ts` | 186, 246, 378, 379 | comments describing the legacy candidate and the removed hardcoded-directory check | informational |
| `vault.ts` | 518 | default vault workspace `<tools root>/0.13/agent-vault` when `$PICO_AGENT_VAULT` is unset | by design: a version LABEL selecting a workspace; every answer is labeled with the revision its `package.xml` declares |
| `vault.ts` | 544, 1108 | `'0.13'` as an example version label in error text and the `sdkVersion` description | by design (example) |
| `vault.ts` | 902, 1105 | `DEFAULT_VAULT_SDK_VERSION = "0.13.3"` and the `vault_api` description naming the 0.13.3 default declarations | by design (the default vault's declared revision, disclosed in the tool's own text) |
| `vault.ts` | 30, 31, 528 | comments | informational |
| `vaultdiff.ts` | 169, 176, 211 | `'0.13'` as an example version label | by design (example) |
| `vaultdiff.ts` | 16, 18 | comments | informational |
| `diagnose.ts` | 277 | remedy text naming `ANDROID_SDK_ROOT=~/Library/PICO/sdk/0.13/emulator/system-images` | informational, and currently TRUE of `scripts/restart-emulator.sh` (`DEFAULT_EMU_ROOT=~/Library/PICO/sdk/0.13/emulator`, AVD `PICO_0.13`); the script is itself a next-sweep item |
| `doors.ts` | 569 | `'0.13'` as an example vault label | by design (example) |
| `doors.ts` | 564 | `pico_sdk` description: "by default the HISTORICAL 0.13.3 declarations" | informational (true of the default vault) |
| `index.ts` | 189 | `toolsVersion` example `'0.13'` | by design (example) |
| `unitygen.ts` | 14, 167, 194 | "structural ceiling on emulator 0.13.x" | informational (a dated, measured ceiling) |
| `editorpalette.ts` | 30, 31 | header comment recording the constant the fix wave removed | informational |
| `adb.ts` | 15, 16, 17 | header comment recording the per-consumer 0.13 path S4 removed | informational |
| `bundlediff.ts` 23; `editorexport.ts` 26; `toolchain.ts` 216; `declarationcontext.ts` 13, 47 | comments about the removed packer fallback and the 0.13.3 vault payload | informational |
| `assets.ts` 187, 230, 378; `inspection.ts` 425; `splatanalyze.ts` 16, 226; `environment.ts` 6, 9, 228; `worldenv.ts` 199; `collider.ts` 7, 18; `grpc.ts` 266, 356, 404; `eye.ts` 310, 314 | "PICO 0.13" / "emulator 0.13.1" / "the CURRENT 0.13 toolchain": prose naming the emulator or SDK build a measurement was made on | informational (dated measurement provenance) |
| `agentbridge.ts` 2057; `anim.ts` 8; `appspec.ts` 259, 263; `attachmentpanel.ts` 12, 27, 234, 310, 323; `bundlelease.ts` 18, 23, 24, 29, 30, 165; `capabilities.ts` 55, 56, 59, 62; `compiler.ts` 255; `components.ts` 371, 459; `containers.ts` 14, 68, 332, 346; `databinding.ts` 8, 29; `display.ts` 8; `ecssystem.ts` 13, 51, 289; `editorcomponents.ts` 14, 26; `editorproject.ts` 14; `events.ts` 13; `interactables.ts` 23; `interaction.ts` 8, 31; `layout.ts` 8, 26; `lint.ts` 343, 347, 526, 549, 560; `media.ts` 8; `panelcompose.ts` 23, 56, 63; `physics.ts` 22; `richness.ts` 9, 26; `router.ts` 8, 21; `sense.ts` 543; `skeletal.ts` 14, 15, 240; `spatialaudio.ts` 10, 13, 39, 69; `spatialgestures.ts` 92, 94; `subwindow.ts` 129, 163, 165; `swan.ts` 50; `tappable.ts` 20 | "SDK 0.13.3" / "0.13.3 sources jars" / "0.13.4 editor binary": the provenance of a declaration, KDoc line or sample a generator was grounded in | informational — labels of what was READ, never paths; each stays until the same fact is re-verified against 6.1 declarations (the vault / compatibility-index work) |
| `missiontable.ts` 252, 253; `setdressing.ts` 42, 68; `splatanalyze.ts` 331; `web3d.ts` 24; `webbridge.ts` 6 | `-0.13f` coordinates, `[0.13, 0.88, 1]` colours, `0.35,0.13` geometry radii, `v10.13` | not a version |

### Deferred minors

Every reviewer minor from the nineteen tasks is recorded in the plan ledger
(`.superpowers/sdd/2026-09-15-cli050-sdk61-evolution/progress.md`, untracked controller scratch),
tagged `minor (deferred)` against its task. The ones with real consequence:

- **Bounded execution.** `scripts/run-battery.mjs`'s outer `spawnSync` timeout (10 min) is shorter
  than `GATE_TIMEOUT_MS` (30 min) with no escalation between them (pre-existing).
- **Publication.** `scripts/publish-tarball.mjs`'s no-hard-link rename fallback has a TOCTOU window
  behind its `wx` probe — accepted as the documented trade-off, unreachable on hard-link-capable
  filesystems (every CI and dev host here). A stale receipt without its artifact reports the failure
  without naming the artifact that did land.
- **Build.** A successful publication can still exit 1 if backup removal fails; orphan detection is
  `.js`-only.
- **Retention.** Capability, observation and perf run directories are never pruned, and each perf run
  now also stores a copy of its report.
- **Rediscovery cost.** After one failed knowledge discovery, every knowledge call repeats the
  registry view plus up to eight bounded help probes — it is per call, not per session.
- **Legacy adb paths.** `validate_toolchain` still spawns `which adb`, and preflight's adb row keeps
  a fourth `LEGACY_SDK_ADB` candidate the shared adapter does not have — a row that can go green for
  a binary nothing runs.
- **Size.** `src/picoclimanaged.ts` (~2 000 lines) and `src/vault.ts` (~1 160 lines) both have a
  natural extraction seam and were left alone under file ownership.
- **Packaged basis.** Two Python snippets in the home-path-redacted SDK compatibility basis are no
  longer verbatim-runnable (`$HOME` is unexpanded) — the deliberate cost of not shipping the
  maintainer's home directory name.
- **Docs gate noise.** `test:docsmeta` warns `homepage/origin check skipped: ENOTDIR .git/config`
  inside a git worktree (warning only, pre-existing).

## Continuation prompt

Copy-paste for the session that picks up the externally blocked work:

```text
Continue the CLI 0.5 / SDK 6.1 work from the 38.0.0 checkpoint in
docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md (routing decisions:
docs/findings/CLI050_CAPABILITY_MATRIX.md). Everything there is fixture- or host-executed;
NOTHING is device- or vision-verified. Do not restate its claims as stronger than they are.

Start with `pico_doctor {}` (read-only). Export PICO_ADB=/fixture/no/such/adb in every shell
you run tests in, and treat a failure under that pin as a fixture finding to repair, never a
reason to unpin. Run `npm run build` before any suite — 70 of 97 test files import ../dist
and nothing rebuilds it.

One gate is red at 38.0.0, by ruling, and it is recorded rather than hidden:
  test:claims — the tracked docs/claims/claims.json (86 apps / 330 claims, 2026-08-13) is a
  month behind this machine's ledger corpus (97 apps / 764 claims). Regenerating it runs
  generate_claims_page AND would publish com.picoagent.missionreplay — the paused app — on the
  public claims page, so it was ruled NOT to be regenerated and claims.json is untouched. CI is
  unaffected (a clean checkout has no ledgers and the assertion self-skips). The fix is to make
  the gate hermetic against a fixture ledger, not to regenerate the snapshot.

The externally blocked work, in the order it is worth doing:
  a. Provision the profiler payload (`<resolved pico-cli absolute path> setup`, run by the
     USER, never by the MCP) and capture exit-0 `perf live run --help` / `perf trace * --help`
     for a real version line. That is the only thing that turns exitZeroHelpObserved:false into
     evidence for the five perf routes.
  b. Host discovery: install the plugin from the 38.0.0 tarball in Claude Code, Codex and
     Cursor, and record host + version, plugin/source identity, the expanded command, the
     startup result and the observed tool requests. Token replacement in tests is structural
     coverage only.
  c. A real Linux and a real Windows `tools/list`. The published 252 is source-derived from the
     three-tool host-GUI registration delta and has never been measured.
  d. Emulator LOOK acceptance. Calibration has been stale since the 2026-09-15 boot. Do not
     calibrate or manipulate the emulator to make a doctor check green; root alone owns
     emulator-5554.
  e. A physical-device run, if and only if the user authorizes it.

Mission Replay stays paused. Do not push; do not rewrite history; never use bare `git stash`.
```

## What this checkpoint is not

It is not a validation. Fixture gates prove that this server's code does what its own contracts say
against injected inputs; the installed-artifact checks prove that a clean install of the 38.0.0
tarball starts and answers on **this macOS host**. Nothing here establishes that pico-cli 0.5
behaves as its source declares, that Spatial SDK 6.1 builds or renders anything, or that a single
pixel reached a screen. The one rule this repository does not negotiate — *"verified" means someone
LOOKED at a rendered frame* — was not satisfied anywhere in this checkpoint, and no claim above
pretends otherwise.

