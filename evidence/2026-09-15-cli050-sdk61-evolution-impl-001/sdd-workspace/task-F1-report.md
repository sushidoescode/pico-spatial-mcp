# Task F1 — implementation checkpoint, capability matrix, 38.0.0 release metadata, battery, distributable

**Status: DONE_WITH_CONCERNS.** Every brief item is complete. Two gates in the battery are red for
reasons I diagnosed precisely and deliberately did **not** patch (one is a genuine defect from
task C4 inside my no-patch boundary; one is pre-existing host state that only an MCP tool could
repair, and repairing it would fold the paused Mission Replay app into the public claims page). A
third red gate was a fixture hermeticity finding and is fixed.

Base: `c40180b`. Six commits. Nothing pushed; no history rewritten; no bare `git stash`.
No emulator, device, MCP tool, calibration or utility-setup operation was performed at any point.
Every command below ran with `PICO_ADB=/fixture/no/such/adb` exported.

## Commits

| Commit | Subject |
|---|---|
| `44b4180` | test: pin host-derived fixture inputs and require an explicit watch_crash target |
| `504d2ed` | test: register the external-APK observation suites as one gate |
| `db24973` | docs: correct the routing rows and counts that explicit-target observation made false |
| `2e1537d` | test: fail the docs gate when package-lock disagrees with package.json |
| `34452a5` | test: make the emulator boot fixture name its own adb |
| `7537932` | chore: checkpoint CLI 0.5 / SDK 6.1 compatibility work as 38.0.0 (the ruled subject) |

Every message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Paths were
reviewed via `git diff --cached --stat` before each commit; `.superpowers/`, `*.tgz` and `*.log`
were never staged (the last two are gitignored anyway).

Ordering note: the version bump was applied early (step 4) but had to land in the *final* commit. To
keep every intermediate commit internally consistent — my new docsmeta check fails if package.json
and package-lock.json disagree — I saved the post-`npm version` files, returned the three version
fields to 37.0.0 and `git checkout`-ed the eight manifests, made commits 1–4, then restored the
saved files byte-for-byte (sha256 `39eba596…` / `00a9e37c…`) and re-ran `npm run sync:meta`, which
reproduced the manifests deterministically. `sync-metadata --check` then reported 0 stale sites.

---

## Step 1 — fixtures and the last defaulted target (`44b4180`)

**RED first**, reproducing exactly the two failures the brief named:

```
$ npm run test:distribution-adoption            # 41 pass / 2 fail
✖ setup-required wrapper results stay source/freshness-neutral and never execute setup
  registry latest/capture_record: {"status":"failed","failureClass":"runtime",
  "note":"device is required: capture_record names the device the recording came from, and there
   is no default target. Pass the adb serial of the device to record."}
  'runtime' !== 'setup-required'
✖ preflight prints the verified emulator-bundle install route but never runs it
  {"name":"emulator","status":"unknown","detail":"cannot check without adb",
   "fix":"Fix the adb check first, then re-run preflight_env."}
  'unknown' !== 'fail'
```

Changes:

- `test/distribution-adoption.mjs` — the `capture_record` case in the setup-required scenario gets
  `device: "fixture-record-0001"`; the emulator-bundle-route PreflightIO declares `adbOverride: null`
  **and** `javaHomeEnv: null` (both are the host-env-derived fields in `PreflightIO`;
  `src/preflight.ts:239,392` read `process.env` only when the field is `undefined`).
- `test/picocli.mjs` — `baseIO` (the object every IO at :81–120 spreads) gets the same two fields, so
  one edit covers all derived fixtures.
- `src/picoclitools.ts` — `watch_crash` now requires `device`. `DEFAULT_WATCH_DEVICE =
  "emulator-5554"` is **deleted**, `WatchCrashRequest.device` is required at the type level (so
  `observeWatchCrash` cannot substitute either), and the registered handler refuses **before**
  `ensurePicoCli()`, mirroring `capture_record` exactly. The input-schema description and the tool
  description say so. The parameter keeps its name per the ledger ruling.
- Fixtures updated: `test/picocli-autoinstall.mjs` (5 `watch_crash` invocations),
  `test/distribution-adoption.mjs` (the setup-required `watch_crash` entry — it would otherwise have
  failed the same way `capture_record` did), `test/cliobservations.mjs` (the default `observe()`
  request, the capability-refusal call, and the argv assertion that expected `-d emulator-5554`,
  now `-d fixture-serial`).

**GREEN:**

```
$ npm run build                        published 190 file(s)
$ npm run test:distribution-adoption   tests 43, pass 43, fail 0     (exit 0)
$ npm run test:picocli                 exit 0   (157 + 21 + picocli.mjs)
$ node --test test/cliobservations.mjs tests 21, pass 21, fail 0
```

## Step 2 — register C6's suites (`504d2ed`)

One Linux `fixture` gate `test:observation` running `test/artifactinspection.mjs` and
`test/verifyapk-observation.mjs`, registered the documented three ways (inventory entry, one-line
package script, workflow step on the Linux lane). The inventory comment states it is **not**
`test/observation.mjs`, which stays in `test:emulator-restart` — the names are close enough to
mislead. Counts derive to 55/54 (linux 52) and moved once, in README.md and docs/COLLABORATORS.md.

```
$ node -e "gateInventoryCounts()"      {"invocations":55,"suites":54,"hosts":{"linux":52,"windows":1,"macos":2}}
$ npm run test:observation             tests 48, pass 48, fail 0     (exit 0)
$ node --test test/gate-inventory.mjs  tests 31, pass 31, fail 0
$ npm run test:lint                    exit 0
    ok published gate-battery size agrees across scripts/gate-inventory.mjs, package.json,
       gates.yml, README.md, and docs/COLLABORATORS.md
       (55 invocations / 54 test: suites; linux 52, windows 1, macos 2)
$ npm run test:docsmeta                exit 0, tests 26, pass 26, fail 0
```

A rebuild was needed first: the build receipt binds `scripts/`, so editing
`scripts/gate-inventory.mjs` made `run-gate` refuse (`the source input identity changed since the
build (14182a6f8e6e -> b173cb7cc910)`). That refusal working is itself R3/R1 evidence.

## Step 3 — doc truth (`db24973`)

Both `docs/DEVICE_VERIFICATION.md` rows were re-verified **against the source at this commit**, not
taken from the C6 report:

| Row | Source check |
|---|---|
| `capture_frame` | `src/capture.ts:61` refuses a missing `serial`; no default. |
| `verify_pico_apk` | `src/verifyapk.ts:174–175` refuses a missing `serial`; `:298–302` force-stops **only** the package it installs; `:368–369` reads `logcat -d` scoped by `--pid` and there is no `logcat -c` anywhere in the file. |

The corrected `verify_pico_apk` row says it *can* be pointed at hardware **and that no hardware run
has been performed** — the routing boundary moved, the evidence did not.

I also re-checked the adjacent row I did not change, so as not to leave a falsehood beside a
correction: `verify_baseline` / `verify_visual` / `capture_canonical` still accept a serial and
default to the emulator (`verifybaseline.ts:33`, `verifyvisual.ts:45`, `eye.ts:321`). True as written.

`AGENTS.md`: re-derived with the command the paragraph itself publishes —

```
$ grep -lE '(from|import\()[[:space:]]*"\.\./dist/' test/*.mjs | wc -l   → 70
$ ls test/*.mjs | wc -l                                                  → 97
```

so "68 of the 95" became "70 of the 97" (the two files C6 added). Outside the policy markers, and
not a `NNN tools` shape, so `sync:meta` cannot rewrite it.

### `docs/claims/claims.json` — inspected, deliberately not edited

The brief allowed either a dated superseded-note or leaving it and documenting why. I inspected
`src/claimspage.ts` and `test/claimspage.mjs` first, as instructed. The finding is stronger than
"append-only":

- The file is **fully generated** — `src/claimspage.ts:198–202`, the `generate_claims_page` tool
  writes `index.html` + `claims.json` from the trust ledgers. It is not hand-maintained.
- The P21 `attestation` at lines 117–119 is a **verbatim historical attestation** copied from a
  ledger. Editing it rewrites history (forbidden by the brief) *and* would be erased on the next
  regeneration.
- It is **already a month stale** independently of this work (see `test:claims` below).

So: left untouched, documented in the checkpoint's open items, and the correction is bound to the
next regeneration — which itself needs the Mission Replay question settled first.

## Step 4 — lock-version guard, then 38.0.0 (`2e1537d`, and metadata in `7537932`)

The fixture (R7's loop over `lock.version` and `lock.packages[''].version`) was added to
`test/docsmeta.mjs` section (a), beside the manifest-version loop.

**RED retained**, `packages[""].version` set to `0.0.0-deliberate-mismatch`
(`evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/docsmeta-lockversion-RED.log`):

```
  ok   package-lock.json version carries version 37.0.0
  FAIL package-lock.json packages[''].version is "0.0.0-deliberate-mismatch" != package.json 37.0.0
       — run `npm version --no-git-tag-version <version>` rather than editing package.json by hand
Docs/metadata gate done. Failures: 1        EXIT=1
```

The **fixture** was restored, not the production metadata: `package-lock.json` sha256 is
`c67edd00c171cf78c6b17357bd9b4e1b2f1665eaced4165a3117aaab4365602b` before and after, verified.

Then the R7 guarded command verbatim (`npmLaunch` from `scripts/plugin-bootstrap.mjs`, the semver
guard, `PICO_MCP_RELEASE_VERSION=38.0.0`):

```
$ node --input-type=module <<'NODE' … npmLaunch(['version','--no-git-tag-version',version]) … NODE
v38.0.0                                   (exit 0)
$ npm run sync:meta                       stamped 8 site(s); 0 warning(s)
$ node scripts/sync-metadata.mjs --check   truth: version=38.0.0  macOS-tools=255
                                           other-host-tools=252  doors=18
                                           --check: 0 stale site(s), 0 warning(s)
$ npm run build                           published 190 file(s) for source e51cb8f1b72b
$ npm run test:docsmeta                   exit 0 — both lock fields carry 38.0.0
$ npm run test:distribution-adoption      tests 43, pass 43, fail 0
```

`scripts/sync-metadata.mjs` needed **no** edit: the lock comparison lives in `test/docsmeta.mjs`
exactly as the R7 interface specified.

### The whole version diff, inspected

`npm version` touched exactly three fields and produced **no** dependency churn:

```
package.json       "version": "37.0.0" → "38.0.0"
package-lock.json  "version": "37.0.0" → "38.0.0"   (top level)
                   packages[""].version 37.0.0 → 38.0.0
```

`npm run sync:meta` stamped eight sites, each a pure version field:

```
.claude-plugin/plugin.json      version
plugin.json                     version
.claude-plugin/marketplace.json metadata.version + plugins[pico-spatial-mcp].version
.codex-plugin/plugin.json       version
.cursor-plugin/plugin.json      version
.agents/plugins/marketplace.json plugins[pico-spatial-mcp].version
.cursor-plugin/marketplace.json  plugins[pico-spatial-mcp].version
.github/plugin/marketplace.json  metadata.version + plugins[pico-spatial-mcp].version
```

No prose was rewritten anywhere — the stamper's `NNN tools` rewrite rule did not fire, because the
tool counts did not change (255 / 252 / 18 unchanged). Final agreement check across all ten sites
plus the lock: all `38.0.0`.

**Policy blocks:** `git diff c40180b..HEAD` over README.md, GETTING_STARTED.md, SKILLS.md, AGENTS.md,
TESTERS.md and docs/HOSTS.md shows exactly two changed lines, both derived counts:

```
-**Tests import `dist/`, and nothing rebuilds it.** 68 of the 95 `test/*.mjs` files carry a
+**Tests import `dist/`, and nothing rebuilds it.** 70 of the 97 `test/*.mjs` files carry a
-The full gate battery has 54 gate invocations (53 `test:` suites plus `smoke`). CI assigns 51 to
+The full gate battery has 55 gate invocations (54 `test:` suites plus `smoke`). CI assigns 52 to
```

No policy byte moved. `test:distribution-adoption` (which holds the canonical block inline and
rejects its vocabulary outside the markers) passes 43/43 with both new documents present.

---

## Step 5 — the battery

### Pre-run inspection, as the brief required

| Gate | What the source says | Decision |
|---|---|---|
| `test:vcamtransport-native` (`scripts/test-cmio-camera-writer.sh`) | macOS-gated; compiles with `xcrun --sdk macosx clang`. Targets synthetic UID `00000000-…-0001` and, **before any case that could reach the producer**, asserts via `--probe-only` that the UID matched *zero* CMIO devices, refusing to continue otherwise ("later cases would write frames into a live camera sink"). | Device-free by construction; Xcode MacOSX 26.5 SDK present → **run**. |
| `test:vcamreader-native` (`…-reader.sh`) | Same compile gate. Uses `--cmio-probe-only` read-only metadata enumeration against an unresolvable UID, and explicitly **skips its readback-block assertion if the reader turns out to be authorized**, "to stay device-free". No camera is opened. | Device-free → **run**. |
| `test:provision` (`test/provision.mjs`) | Part 2 bakes with the **real** spatialbundle when a toolchain is present. Source read: it writes one procedural USDA into a fresh `fs.mkdtempSync` dir, bakes `gem0.bundle` beside it, removes the tree (`:85–105`). No user project, no device, no emulator. | Temp fixture only → **run** (the brief's condition for skipping is not met). |

No gate in the inventory touches a device, the emulator or a personal checkout: R4 made smoke
hermetic and R3 scope-based planning covers the rest.

### The run

```
$ node scripts/run-battery.mjs "$PWD" \
    "$PWD/evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/battery-38.0.0.log"

PICO gate battery (55 invocations)   host: macos
BATTERY FAIL  52/55 passed; 3 failed:
  test:claims [exit 1], test:emulator-restart [exit 1], test:spatialui-adoption [exit 1]
```

**Skipped: 0.** The battery plans by scope, so every `fixture`/`installed-artifact` gate runs on any
host and only a `native-contract` gate assigned to *another* OS is skipped; this host is macOS and
both native gates are macOS-assigned. Log: 453 kB, untracked (`*.log` is gitignored).

### Every gate's result

**52 PASS** (times from the runner): `smoke` 1.2s · `test:tarball` 13.8s · `test:smoke-isolation`
2.1s · `test:sdk-integration` 0.2s · `test:lint` 1.3s · `test:projectgen` 0.3s · `test:unitygen`
0.2s · `test:surfaceplace` 0.2s · `test:vault` 0.2s · `test:semantic` 0.3s · `test:ledger` 28.1s ·
`test:eye` 2.0s · `test:assetgate` 0.2s · `test:worldenv` 0.1s · `test:referring` 0.2s ·
`test:doors` 19.4s · `test:prompts` 0.8s · `test:archetype` 2.5s · `test:bench` 0.5s ·
`test:affordance` 0.2s · `test:occupancy` 0.3s · `test:copilot` 0.1s · `test:vaultdiff` 0.2s ·
`test:preflight` 1.5s · **`test:provision` 4.7s** · `test:bridge` 4.9s · `test:vcam` 1.8s ·
`test:vcamtransport` 0.5s · `test:vcamboundary` 0.2s · `test:vcamreader` 0.2s ·
`test:vcamthroughput` 0.2s · `test:vcammaterialize` 0.3s · **`test:vcamtransport-native` 2.0s** ·
**`test:vcamreader-native` 1.7s** · `test:briefroute` 1.3s · `test:modelmeasure` 0.2s ·
`test:docsmeta` 0.4s · `test:picocli` 98.3s · `test:runreceipt` 44.0s · `test:runrevision` 117.3s ·
`test:sdkselection` 0.5s · `test:swan` 0.4s · `test:placeonsurface` 0.2s · `test:menuactions` 0.2s ·
`test:adoption-safety` 3.1s · `test:distribution-adoption` 21.5s · `test:knowledge-lifecycle` 27.5s ·
`test:conformance` 1.7s · `test:buildfreshness` 0.8s · `test:plugin-bootstrap-freshness` 0.7s ·
**`test:observation` 0.5s** · `test:picocli-win` 95.3s.

Two results worth naming:

- **`test:provision` really baked** with the host's 6.1 spatialbundle:
  `ok bake smoke: gem0.bundle baked for real (3.4 KB, modelName=gem0)` — into its own temp tree, as
  the source predicted. This gate is host-toolchain-dependent and self-SKIPs without an SDK.
- **Both native-contract gates really compiled** (2.0 s / 1.7 s). They are not the off-macOS
  `exit 0 "skipped"` path.

### FAIL 1 — `test:emulator-restart`: hermeticity finding, FIXED (`34452a5`)

Three cases in `test/emulator.mjs`, all:

```
Error: $PICO_ADB=/fixture/no/such/adb names no existing file. An explicitly configured adb is never
replaced by a PATH or bundled candidate, so no fallback was attempted …
```

**Not a test reaching a real device.** `runBootFixture` already builds its own fake `adb`
(`test/emulator.mjs:31,44–53`) and puts it first on the child's `PATH` (`:92`). The defect is that
its hermeticity was a property of **PATH order and the absence of a host variable**: the child
spreads `...process.env`, so an inherited explicit `PICO_ADB` defeated the fake beside it and S4's
(correct) fail-closed rule refused to substitute. Any developer with `PICO_ADB` set hits this.

Fix: the child env declares `PICO_ADB: fakeAdb`. A fixture should *name* its tools, not arrange for
the right one to be found.

```
$ npm run test:emulator-restart    exit 0 — tests 690, pass 689, fail 0 (1 platform skip)
```

This is the fourth hermeticity finding of the plan and it validates the controller's pin ruling:
the pin found a fixture whose safety was accidental.

### FAIL 2 — `test:claims`: pre-existing host state. NOT patched, and should not be.

```
FAIL tracked public claims snapshot is stale against the current effective ledger read
```

`test/claimspage.mjs:198–206` compares tracked `docs/claims/claims.json` against a live regeneration
from `~/.pico-mcp/ledgers`, and its own comment says the assertion is maintainer-machine-specific
(CI has no local corpus and skips it). Measured read-only:

| | tracked | live |
|---|---:|---:|
| apps | 86 | 97 |
| claims | 330 | 764 |

Eleven apps exist only in the live read — including **`com.picoagent.missionreplay`** — and eleven
more differ; none were dropped. Tracked snapshot last committed **2026-08-13** (`96c54a3`); newest
local ledger **2026-09-14**. Pre-existing drift, not a regression from this checkpoint, and nothing
I changed writes ledgers.

Not repaired, for two independent reasons: it needs `generate_claims_page` (an MCP tool operation,
out of scope), and the regeneration would fold the **paused** Mission Replay app into the public
claims page. Recorded in the checkpoint's open items and in the continuation prompt.

### FAIL 3 — `test:spatialui-adoption`: a genuine defect from C4. NOT patched (brief boundary).

```
AssertionError: src/spatialbench.ts changed outside this task
  actual   0986672c8cd5425c82211d432a52e6f2485d465be4b77102d1d43546bef49ef0
  expected f131b6c19da12ed2741b1dfd366ce2545cb2f7b5d15963e130b11f0bc33e431e
```

`test/spatialui-adoption.mjs:16–19` pins the bytes of two protected files so adoption work can never
inflate the public benchmark corpus. **C4 (`f41fb8e`) edited `src/spatialbench.ts`** — a notes-string
change on the perf-axis fallback path, correct in itself — and did not update the pin. The gate has
been red since `f41fb8e`, through the CLI merge, I1, C6 and `c40180b`, because no lane ran it. The
expected hash equals the file at base `4478238`, confirming C4 is the only change.

What I verified before deciding: the guard's **substantive** invariants hold — `BENCH_CORE` and
`BENCH_MR` are byte-intact in `src/spatialbench.ts`, and the second protected file
`briefs/calib.json` still matches its pin `b9b76f5f…`. So the corpus was not inflated; only the byte
pin is stale, and the repair is a one-line re-pin.

I did not make it. The brief says to stop and report a genuine defect rather than patch unrelated
code, `test/spatialui-adoption.mjs` is not in my ownership, and re-pinning a protection guard to make
a gate green is precisely the move that guard exists to prevent. **This is my main concern and needs
a decision: someone should review C4's touch of a protected file and re-pin deliberately.**

---

## Step 6 — the distributable

```
$ node scripts/verify-tarball.mjs --publish \
    "$PWD/evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/pico-spatial-mcp-38.0.0.tgz"
Tarball verification done. Failures: 0        (exit 0)
```

| | |
|---|---|
| Artifact | `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/pico-spatial-mcp-38.0.0.tgz` |
| sha256 | `941e402bb2c234c444e31c62c9bc9dc2c69055ac3aeee48c960e870e100f36d6` |
| Bytes | 2,158,783 |
| Receipt (tracked) | `…/release/pico-spatial-mcp-38.0.0.tgz.receipt.json` — 48 checks, all `pass` |
| Packed build receipt | source `e51cb8f1b72b` (195 inputs) → output `68a3d0a73884` (190 emitted), tsc 5.9.3, node major 25 |
| Platform | `darwin/arm64`, node `v25.8.1` |

The `.tgz` is gitignored; the receipt is tracked and carries the hash and byte count, so the
archive's identity survives in Git.

**Prior archives untouched**, re-hashed read-only against
`evidence/2026-09-15-cli050-sdk61-evolution-audit-001/README.md`:

```
0eabffe9b6a92c9a96fe61ea38f3213b0971216f0db7c4d19f9da46660ba9524  picoxr-pico-cli-0.4.4.tgz  37,470,411 B  ✓ matches
a2afe604b3435a83debe1a42706fa4fe0b9e14d026c857873e8fc21f6ac68642  picoxr-pico-cli-0.5.0.tgz  38,104,171 B  ✓ matches
```

(They live in the main checkout, not this worktree — `*.tgz` is gitignored so they were not carried
across. Read only; nothing in that directory was modified.)

### Installed `tools/list` and representative requests (host-executed, macOS)

From the clean `--omit=dev` install of the 38.0.0 tarball, not from this checkout:

| Observation | Result |
|---|---|
| `tools/list`, full surface | **exactly 255 tools for darwin** |
| `tools/list`, `PICO_MCP_SURFACE` unset | **18 door tools** (full stays an explicit opt-in) |
| Anchor tools | all 43 present |
| Door request #1 | 20 concurrent first door calls started **exactly one** inner server (all `unavailable`) — C5's single-flight contract on the installed artifact |
| Door request #2 | installed `pico_look` forwarded the inner screencap failure as `isError`, never `status:"ok"`; stub adb recorded 1 invocation with the `exec-out screencap` argv |
| Full-surface request | `preflight_env` ran from the installed copy: 14 checks, `status: problems`, fixes contain no repo-only commands |
| Shipped SDK payload | reviewed SDK-compatibility payload verified (3 files: index + every referenced record/basis) |
| Leak scan | no absolute home paths in any shipped file; no build droppings |

**Explicitly not performed, and so not claimed:** no Windows or Linux run (the published 252 stays
source-derived; `test:picocli-win` is a fixture gate that ran here on macOS); **no Claude/Codex/Cursor
host discovery** — no host loaded, expanded or registered these manifests, and test-side token
replacement is structural coverage only; no emulator, device or frame. The receipt's own
`limitations` array states the same three limits.

---

## Step 7 — the two documents

- **`docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md`** — evidence-class table; identity (base
  `4478238`, head `c40180b`, build receipt in/out hashes, 190 files, node/tsc); why 38.0.0 and not
  a minor; **one row per task with its commits and before/after** (R1–R6, C1–C6, S1–S6, I1, F1);
  every command and result above; the full battery table with all three failures diagnosed; the
  distributable identity and installed observations; **the three hermeticity incidents quoted
  verbatim** from the S4, R4/C5 and C6 reports — including C6's ~20 irreversible emulator
  logcat-buffer clears, with the report's own "I cannot restore the cleared log buffer — that loss
  stands" — plus the fourth finding from this task; deferred minors; open items; the copy-paste
  continuation prompt; and a closing section saying plainly what this checkpoint is *not*.
- **`docs/findings/CLI050_CAPABILITY_MATRIX.md`** — availability on this host (registry latest
  `0.5.0`; this host's managed cache `0.4.4`, so every 0.5-only capability is a **declaration read,
  not a command run**); the 69→91 command-tree delta with the three removals; the routing map with
  an explicit **delegates / composes / none** verdict and evidence class per capability area
  (knowledge server/doctor/list/pull, perf live + four trace routes + daemon/doctor/session,
  watch-crash, capture record, project context doctor, plugin install/uninstall, the whole spatialml
  tree, editor bootstrap/sync); the two routes that changed *meaning* (knowledge argv; `perf monitor`
  → `perf live`); the **Editor bootstrap review** with its integration rule ("consume manifest/review
  artifacts; an Editor decision is not app or native evidence"); and the **dated-lessons version-scope
  rule**, with the matched `pico-cli-interactive-hangs` rule quoted — its `fix` recommends
  `pico-cli mcp doctor`, a command 0.5.0 removed. The rule was read, not applied, and not deleted;
  the user's local lesson store was not modified.

Both pass the public-docs gate:

```
$ npm run test:docsmeta
  ok   all 167 relative markdown links resolve (74 git-tracked files: root *.md + docs/**)
  Docs/metadata gate done. Failures: 0        tests 26, pass 26, fail 0
```

Link discipline: the documents link only to **tracked** targets (each other, `docs/superpowers/plans/…`,
`docs/CLI_050_SDK61_EVOLUTION_HANDOFF_2026-09-15.md`, and the tracked `.tgz.receipt.json`). The
untracked artifacts — `battery-38.0.0.log`, `docsmeta-lockversion-RED.log` (gitignored by `*.log`),
and the controller's `.superpowers/` ledger — are cited as plain backticked paths, never as markdown
links, because `test/docsmeta.mjs` resolves links against the working tree and a clean CI checkout
would not have them.

Mission Replay: untouched. Not edited, built, installed or migrated; not referenced as evidence.

---

## Self-review

- **Traceability.** Every number in both documents was re-derived or quoted from a retained artifact.
  Spot-verified at the end: all cited help-invocation numbers against `RAW_HELP_INDEX_002.json` —
  `012` (0.4.4 `perf --help`, exit 1), `025`/`026` (exit 0), `062` (`mcp dev-knowledge`, exit 0),
  `096`/`097` (0.5.0, exit 0), `137`–`141` (0.5.0 perf tree, **all exit 3**) — plus the 69/91 command
  counts (`HELP_COMPARISON_002.json`), the C5 transport numbers (`doors-transport/README.md`), the
  claims delta (computed read-only here), and both tarball hashes.
- **No over-claim.** Grep over both documents: `device_verified` 0, `vision_verified` 0,
  "verified on device" 0, "guarantee" 0. "validated" appears twice — once quoting the CLI's own
  `--bind-mcp-to-local-cli` label, once in the sentence explaining that the word is deliberately
  absent from the release subject. "cross-platform" appears once, in the evidence-class table as
  something `host-executed` **cannot** establish. Every "proven" match is "unproven"/"provenance".
- **Version/lock/manifests agree.** All ten manifest sites plus both lock fields read `38.0.0`;
  `sync-metadata --check` reports 0 stale sites, 0 warnings.
- **Policy blocks byte-identical.** `git diff c40180b..HEAD` over the six pinned documents shows only
  the two derived count lines. `test:distribution-adoption` 43/43 with both new documents present, so
  no policy vocabulary leaked outside the markers.
- **No forbidden operation.** No emulator, device, MCP tool, calibration, `pico-cli setup`, global
  CLI/PATH change or host-plugin reconfiguration. No Mission Replay test. Reading
  `~/.pico-mcp/ledgers` and the two audit `.tgz` files was read-only.
- **Nothing pushed.** Branch has no upstream; 61 commits ahead of `origin/main`. No history rewritten;
  no bare `git stash` (the one version-field hold used saved file copies, restored and hash-verified).
- **Staging.** Reviewed with `git diff --cached --stat` before each commit; `.superpowers/`, `*.tgz`
  and `*.log` never staged.
- **Build freshness.** `verifyBuild` at HEAD: `{"current":true,"reasons":[]}`.

## Concerns

1. **`test:spatialui-adoption` is red and needs a decision (main concern).** C4's `f41fb8e` edited
   the protected `src/spatialbench.ts` and left its byte pin stale, so the gate has been failing
   silently since that commit. The corpus lanes and `briefs/calib.json` are intact, so the fix is a
   deliberate one-line re-pin after someone reviews C4's diff to that file. I did not do it: it is
   outside my ownership and re-pinning a guard to go green is the exact move the guard prevents.
2. **`test:claims` is red for host-state reasons, and regenerating it is a policy decision.** The
   tracked public snapshot is a month behind this machine's ledgers. Regeneration needs
   `generate_claims_page` **and** would publish `com.picoagent.missionreplay` — the paused app — on
   the public claims page. Settle that before regenerating.
3. **CI will now run `test:observation` on the Linux lane for the first time.** It passes here
   (48/48) and both suites are hermetic under the pin, but it has never run on Linux.
4. **`watch_crash` requiring `device` is a breaking input change** beyond the four C6 already made.
   It is covered by the 38.0.0 major and documented, but any caller relying on the implicit
   `emulator-5554` now gets a structured refusal.
5. **The gate battery has one blind spot the inventory cannot see:** `gates.yml`'s macOS lane runs
   `node --test test/homeenvironmenthost.mjs` as a raw step rather than a named gate, so
   `AGENTS.md`'s "one inventory owns every gate command" is true of every *named* gate but not of
   that line. Pre-existing; recorded in the checkpoint.
6. **Nothing in this checkpoint is native or visual evidence,** and the checkpoint says so in its
   title section, its evidence table and its closing paragraph. The externally blocked work
   (provisioned profiler help, native sampling, Windows/Linux `tools/list`, host discovery, emulator
   LOOK, physical device) is enumerated with a copy-paste continuation prompt.

---

# Continuation — controller rulings on the two red gates (commit `ad6d837`)

Both rulings applied in the same worktree/branch with `PICO_ADB=/fixture/no/such/adb` exported.
One commit: `ad6d837` *test: re-pin the reviewed SpatialBench scoring change and record the claims
gate ruling*. Only the three affected gates were re-run, not the battery. Nothing pushed.

## Ruling 1 — `test:spatialui-adoption`: re-pinned, green

The ruling's reading of the guard is confirmed by the file. `test/spatialui-adoption.mjs:17` is a
**change-detection** pin; the assertions that carry the contract are separate, and I re-checked each
one before moving the hash:

| Assertion | Line | State |
|---|---|---|
| `BENCH_CORE` membership (8 lanes) | :26 | unchanged, passing |
| `BENCH_MR` membership (3 lanes) | :27 | unchanged, passing |
| `src/spatialbench.ts` contains no `docs-adoption-workbench` | :354 | unchanged, passing — this is the assertion that actually enforces "a repo-only recipe never inflates the benchmark corpus" |
| `briefs/calib.json` against its own pin `b9b76f5f…` | :18 | unchanged, passing |

Change made — one line plus a three-line comment, nothing else:

```js
const protectedFiles = new Map([
  // Re-pinned for f41fb8e (C4: missing-measurement propagation into the perf axis), reviewed and
  // approved in the 38.0.0 checkpoint — see task-C4-report.md. The semantic assertions below are
  // what this guard actually protects; this hash only detects change.
  ["src/spatialbench.ts", "0986672c8cd5425c82211d432a52e6f2485d465be4b77102d1d43546bef49ef0"],
```

(Was `f131b6c19da12ed2741b1dfd366ce2545cb2f7b5d15963e130b11f0bc33e431e`, the file's bytes at base
`4478238`.)

```
$ npm run test:spatialui-adoption    exit 0 — SpatialUI adoption test done. Failures: 0
$ npm run test:bench                 exit 0 — SpatialBench test done. Failures: 0
```

`test:bench` matters here beyond the ruling's "once": it is the other consumer of the scoring path
C4 changed, so its green is what makes the re-pin a record of a reviewed change rather than a
suppressed regression.

## Ruling 2 — `test:claims`: left red, recorded

`docs/claims/claims.json` was **not** touched and the page was **not** regenerated. The checkpoint
now states the ruling and its reason (regeneration would publish the paused
`com.picoagent.missionreplay` on the public claims page), the measured drift (tracked snapshot
2026-08-13, 86 apps / 330 claims vs this host's 97 / 764), and one fact worth making explicit that
the original write-up left implicit: **CI is unaffected** — a clean checkout has no
`~/.pico-mcp/ledgers`, so the assertion self-skips. The gate fails only on a machine that owns a
live corpus, and it fails there for *any* maintainer whose ledgers have moved since the snapshot was
generated, independently of what they changed.

That reframes it from "stale artifact" to "a gate reading host state as if it were repository
state", which is how it is now recorded in the open-items table, with the ruling's open item:
**make `test:claims` hermetic against a fixture ledger**, so the gate exercises the generator and
the tracked snapshot rather than the developer's private corpus.

## Checkpoint document updates

- New **disposition table** at the head of the battery section: `test:emulator-restart` FAIL → fixed
  (690 tests, 0 fail); `test:spatialui-adoption` FAIL → re-pinned, pass; `test:claims` FAIL → fail by
  ruling, still red. The recorded battery run itself is unchanged — it remains the single
  `52/55, 0 skipped` run — with the table saying where each failure landed afterwards.
- Failure 1 retitled "FAIL BY RULING. A host-state failure, left red on purpose", with the CI-skip
  fact and the hermeticity framing.
- Failure 3 retitled "FAIL, then RE-PINNED after review. Now green", listing the four semantic
  assertions that were re-checked, the ruling, and both re-run results.
- Open items: added the `test:claims` hermeticity row.
- Continuation prompt: the two-red-gates paragraph replaced by one accurate paragraph — only
  `test:claims` is red, by ruling, and the fix is a fixture ledger rather than a regeneration.

```
$ npm run test:docsmeta
  ok   all 167 relative markdown links resolve (74 git-tracked files: root *.md + docs/**)
  Docs/metadata gate done. Failures: 0        tests 26, pass 26, fail 0
```

## Self-review

- Semantic assertions unchanged: the diff to `test/spatialui-adoption.mjs` is **+4 / -1** — three
  comment lines and the hash. No assertion, no `protectedFiles` entry, nothing else moved.
- The new hash was taken from `shasum -a 256 src/spatialbench.ts` at this commit and matches the
  `actual` the failing gate reported, so the pin records the reviewed bytes rather than a value I
  computed some other way.
- `docs/claims/claims.json` and `docs/claims/index.html` untouched — `git status` clean apart from
  the two committed files.
- No emulator, device, MCP tool, calibration or setup operation. No push, no history rewrite, no
  bare `git stash`. `.superpowers/`, `*.tgz` and `*.log` not staged.
- Gate state at `ad6d837`: `test:spatialui-adoption` pass, `test:bench` pass, `test:docsmeta` pass,
  `test:emulator-restart` pass (from `34452a5`), `test:claims` red by ruling. Every other gate's
  result stands from the recorded battery run.

## Concern (one, and it is the honest residue)

The re-pin means this guard is now only as strong as the review behind the hash. C4's change was
reviewed in this checkpoint and the four semantic assertions still hold, so the pin is sound today —
but a change-detection pin that gets re-pinned whenever it fires teaches people to re-pin. If that
guard is meant to keep protecting the benchmark corpus, its value is in the semantic assertions at
`:26-27` and `:354`, and those are worth extending; the hash is a tripwire, not the contract.

---

# Fix round 1 of 5 (commit `0fa7c71`)

Five items: one Important documentation defect from the review, four on F1's own changes. Same
worktree/branch, `PICO_ADB=/fixture/no/such/adb` exported. One commit, nothing pushed.

## 1 (Important) — the R4 incident was under-reported

The reviewer is right, and the defect was mine: I quoted R4's captured stdout through
`emulator_list` and stopped, then wrote a disposition — "It was a read-only listing; nothing was
installed, launched or stopped" — that is true of the *device* and silently stands in for the whole
run. A reader came away with a read-only device enumeration when a third-party binary had been
spawned against the user's personal project directory.

The quote now runs through the `pack_bundle` block (`task-R4-report.md:168-172`) and carries R4's
own summary (`:176-178`) verbatim:

> That is the expected Claimsight/host-probe failure, preserved: **a hardcoded personal checkout with
> no existence guard, a real `spatialbundle` binary executed, and a real hardware serial enumerated.**

The disposition is now split, because the two things have different dispositions:

- **The device listing was read-only.** Physical PICO `2G0YC5ZF7Z056Q` alongside the emulator;
  nothing installed, launched or stopped on either.
- **A third-party binary really executed against the user's personal project.** The host's real
  PICO 6.1 packer (`/Users/sushantsrikrish/Library/PICO/sdk/6.1/editor/spatialbundle/spatialbundle
  pack -s …`) ran with a scenes path under the hardcoded `AndroidStudioProjects/claimsight`
  checkout. It **failed with exit 19 and produced no bundle** — so nothing was written there, but
  that is the *outcome of the run*, not a limit the test imposed: the binary was invoked and the
  personal checkout was read.

A closing paragraph names this as the defect R4 then removed (smoke builds its whole environment;
the real-SDK lane became a separate explicitly-invoked non-gate command).

## 2 — `watch_crash` schema

`src/picoclitools.ts:430`: `z.string().optional()` → `z.string()`. Required in the **schema**, so a
client omitting `device` is refused by the protocol before the handler runs; the handler's refusal
remains the typed-result path for the empty / whitespace-only string a schema cannot reject, which
is stated in a comment above the field.

`verify_pico_apk` and `capture_record` still carry the softer shape. Rather than silently widen
scope I rewrote the open-items row to name all three, with `watch_crash` as the model and the note
that each of the other two is a one-line change for the next surface sweep.

## 3 — the refusal test

Added to `test/cliobservations.mjs` (where `watch_crash`'s tests live), mirroring
`test/verifyapk-observation.mjs:591-604`. It asserts:

| | |
|---|---|
| Typed result | `status: "failed"`, `failureClass: "runtime"`, note matches `/device is required/i` and `/no default target/i`, and `packageName` echoed |
| Refusal precedes resolution | **absence of `picoCli` provenance** — it only ever appears after a successful ensure, so its absence proves no registry lookup, no provisioning, no managed-store write |
| The case a schema cannot catch | a whitespace-only `device: "   "` is refused by the handler |
| Schema strength | `metadata.watch_crash.inputSchema.device.isOptional() === false` |
| Compiled source | no `emulator-5554` anywhere in `dist/picoclitools.js`; no `request.device ??` fallback; and `watchArgv(request.packageName, request.device,` present, i.e. the declared target reaches argv unmodified |

I checked the schema assertion actually discriminates rather than passing vacuously:

```
watch_crash.device.isOptional()  : false
capture_record.device.isOptional(): true   (control — still optional, so the assertion can fail)
```

## 4 — `test/cliobservations.mjs:361`

`observe()` was called without a `device` while its sibling at `:365` had been updated. Fixed, and I
swept every `request:` override in the file — those two are the only ones; every other call uses the
default request, which already carries `device: "fixture-serial"`.

## 5 — the over-broad evidence-class sentence

"Every claim below carries its evidence class" was not true of the per-task before/after table or
the "Why 38.0.0" list. Reworded to say which sections label every row (class table, capability
matrix, battery, distributable, open items) and to state plainly that those two sections are
**`source-inspected` throughout**, describing changes as the code and commits show them and
asserting nothing about runtime behavior.

## Commands and results

```
$ npm run build                          build-source: published 190 file(s) for source 89347aafb384
$ npm run test:picocli                   exit 0   (157 + 22 + picocli.mjs)
$ node --test test/cliobservations.mjs   tests 22, pass 22, fail 0
$ npm run test:observation               tests 48, pass 48, fail 0
$ npm run test:prompts                   exit 0   (tests 3, pass 3, fail 0)
$ npm run test:docsmeta                  tests 26, pass 26, fail 0
$ npm run test:distribution-adoption     tests 43, pass 43, fail 0
```

`test:distribution-adoption` is not on the reviewer's list; I ran it because making the schema
required is a **public contract change** validated at the protocol level, and that suite is the one
that drives `watch_crash` through a real MCP client over stdio. Green, so the strict schema does not
break the client path.

## Self-review

- The Important item is fixed at the level it was raised: the quote is extended, R4's summary
  sentence is included verbatim, and the disposition no longer lets a device-scoped statement cover
  a binary execution.
- The schema change is narrow: `src/picoclitools.ts` is +4 / −1 (the field plus a three-line
  comment). No handler logic moved — the refusal path is unchanged and still tested.
- The new test's compiled-source assertions are written against `dist/`, so they check what ships
  rather than what the TypeScript says.
- No emulator, device, MCP tool, calibration or setup operation. Nothing pushed; no history
  rewritten; no bare `git stash`. `.superpowers/`, `*.tgz`, `*.log` not staged.

## Concern

Only one, and it is the same shape as last round's: `capture_record` and `verify_pico_apk` now
differ from `watch_crash` in schema strictness while all three share the same prose. That is
recorded in the open items rather than fixed, because tightening two more public input schemas is a
contract change beyond this round's scope — but it is the kind of inconsistency that reads as an
oversight later, and it is worth closing in one deliberate pass.
