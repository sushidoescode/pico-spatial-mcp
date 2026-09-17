# CLI 0.5 / SDK 6.1 native-acceptance checkpoint (38.1.0)

The record of the 2026-09-16 native-acceptance pass on branch `cli050-native-acceptance-2026-09-16`,
continuing the accepted host-only tip `f349eaf` (38.0.0). It continues, and does not replace,
[CLI050_HOST_COMPLETION_CHECKPOINT.md](CLI050_HOST_COMPLETION_CHECKPOINT.md) and
[CLI050_IMPLEMENTATION_CHECKPOINT.md](CLI050_IMPLEMENTATION_CHECKPOINT.md), both of which stay
byte-untouched. Companion: [CLI050_CAPABILITY_MATRIX.md](CLI050_CAPABILITY_MATRIX.md).
Evidence root: `evidence/2026-09-16-mcp-native-acceptance-001/`; every row of the execution ledger
is in that directory's `LEDGER.md`.

**What this checkpoint adds that the host-only one could not.** The 38.0.0 pass earned
`host-executed` at best: no emulator was booted, no device touched, no frame captured, no frame
looked at. This pass ran the candidate against the registry's current CLI, the installed 6.1
toolchain and a running emulator, and it **looked at rendered frames**. That is where its three
defects came from — none of them is visible by reading the source.

**What it still does not establish.** Nothing here is hardware. No physical PICO headset was
attached at any point in this pass, so every device claim below is `C0_emulator` and the headset
lane is open, not failed. No profiler payload is provisioned, so no perf number was measured. No
Linux or Windows host ran anything.

## Evidence classes used here

| Class | Meaning | Earned here |
|---|---|---|
| `source-derived` | Read from this repository's own source or commits; no execution. | yes |
| `fixture` | Exercised through production code paths against injected inputs or a fake child. | yes — the three new suites |
| `host-executed` | Really ran on this macOS host and the result is retained. | yes — the CLI, the SDK resolution, the Gradle build, the battery |
| `vision_verified` | A rendered frame was captured and a human/agent LOOKED at it. | **yes — four frames, on the emulator** |
| `device_verified` | The same, on physical hardware, with a live serial probe. | **no — no headset was attached** |

## 1. Identities

### Active server at session start (not the candidate)

The read-only `pico_doctor {}` that opened this session was answered by **PID 52521 =
`node /Users/sushantsrikrish/PICO-MCP/dist/index.js`**, the main checkout at `4478238`, whose
`package.json` reads **37.0.0** and whose `dist/index.js` was built on 2026-09-08 with no build
receipt at all. A direct-transport probe of that exact entry returns `serverInfo.version 37.0.0`.
So the doctor output quoted in the handoff README describes the *old* server. Verbatim copy:
`evidence/.../host/connected-server-pico_doctor-2026-09-16.json`.

Its one failing check was `calibration` (calibrated 2026-09-04, emulator booted 2026-09-15) and its
`accessibility` row was `unknown`. **Accessibility is in fact granted** — this pass exercised
`AXRaise` and CGEvent input successfully — but that is not something a read-only check can prove,
so the row is honest.

### Source and package

| Fact | Value |
|---|---|
| Accepted base | `f349eaf01f9788d0fe73fefbd30af17b7dccf776` (38.0.0), branch `cli050-sdk61-evolution-2026-09-15` |
| Continuation branch | `cli050-native-acceptance-2026-09-16`, worktree `.worktrees/cli050-native-acceptance-2026-09-16` |
| Main at session start | `4478238a8d7aac266b12c2b8dc61c08482337286` — the exact merge-base of `f349eaf`; 110 commits behind, 0 ahead, so a fast-forward |
| Build receipt at base | input `bafeb2712c5b…`, output `f4978b711f57…` — identical to the accepted 38.0.0 receipt, reproduced from a clean `npm ci` |
| Released here | **38.1.0**, receipt input `2c2b42c2177c…`, output `05420e230d44…`; 8 manifest sites stamped by `npm run sync:meta` |
| Surface | doors 18 tools, full 255 tools (direct-transport `tools/list`, both measured) |

The three retained 38.0.0 archives were not touched. 38.1.0 is a new version because source bytes
changed, per the repository's release rule.

### pico-cli

| Fact | Value |
|---|---|
| Ambient global (untouched) | `~/.nvm/versions/node/v25.8.1/bin/pico-cli` → `pico-cli/0.4.4 (public) darwin-arm64` |
| MCP-owned cache at session start | `0.4.4` only |
| Registry offering on 2026-09-16 | `0.5.0` (`npm view`, and the candidate's own lookup, `checkedAt 2026-09-16T21:41:57.497Z`) |
| Resolved and used here | `/Users/sushantsrikrish/.pico-mcp/cli/versions/0.5.0/node_modules/.bin/pico-cli`, freshness `latest` |
| Package identity | `packageJsonSha256 0b1ee26a…`, `executionTreeSha256 65325e71…` |

`ensure_pico_cli` provisioned it; nothing global and no `PATH` entry changed. Evidence:
`evidence/.../cli/candidate-ensure_pico_cli-001.json`.

**CLI 0.5 capability, as measured on this host:**

| Operation | State | Why |
|---|---|---|
| `knowledge server` | **supported** | exit 0, usage line names the route (after the ANSI fix below; before it, wrongly `unknown`) |
| `app watch-crash` | **supported** | same |
| `capture record` | **supported** | same |
| `perf live run` | **unavailable** | exit 3 at the CLI's own utilities gate: `Perf utilities 0.2.0 are not installed.` |
| `perf trace record` / `decode` / `load` / `query` | **unavailable** | same gate, same exit |

The profiler payload is not installed, so **no perf lane ran and no perf number exists.** The
package activation step is a user action; the exact command is in §9.

### SDK / toolchain

| Component | Value | Read from |
|---|---|---|
| Tools root | `~/Library/PICO/sdk` (`$PICO_HOME`) | toolchain selection |
| Installed | `0.13`, `6.0`, `6.1`; selected **6.1** | `pico_doctor` |
| Packer | `spatialbundle 6.1.0.0-rls.25`, sha256 `8797c557…` | `scaffold_spatial_app` toolchain block |
| Editor payload | **6.1.9** | `6.1/editor/package.xml` revision 6.1.9 |
| Emulator payload | **6.1.0** | `6.1/emulator/package.xml` revision 6.1.0 |
| Public Maven BOM versions | `0.12.2`, `0.13.3`, `6.0.0`, **`6.1.9`** (release, lastUpdated 20260902062140) | `artifact.bytedance.com/.../com/pico/spatial/bom/maven-metadata.xml` |
| Channel advertises | a `6.2` line (spatialSDK 6.2.1; `pico_spatial_editor_20260910_v6.2.2_*.zip`) — **internal-only, not downloadable from here** | `check_toolchain_updates` |
| App skeleton pin (unchanged) | `6.0.0` | `appskeleton/gradle/libs.versions.toml` |

**A tool installation labelled 6.1 is not a BOM decision**, and this pass kept them separate: the
skeleton still pins 6.0.0, and only the new demo project was moved to 6.1.9 — the only published
BOM on the 6.1 line.

### Devices

| Target | Identity | Status |
|---|---|---|
| `emulator-5554` | product `swan`, model `swan_arm64`, device `pico_spaceos_emulator_arm64`, fingerprint `Pico/swan/pico_spaceos_emulator_arm64:16/BQ2A.260122.002-BP2A.250705.008/4766:user/test-keys`, Android 16 / API 36, `arm64-v8a`, display id `6.1.0`, `ro.boot.qemu=1`, boot id `c57ce474-…` | used for the whole native lane |
| physical headset | **none attached** | `adb devices -l` lists only the emulator; the USB tree contains no PICO/ByteDance device; `adb mdns services` is empty |

The marketing name "Space Pro" was not used as evidence for anything. A read-only identification
tool that refuses to guess is committed at `evidence/.../tooling/headset_identify.py`; its run today
is `evidence/.../device/headset-identify-001.json` (exit 3, no physical candidate).

## 2. What executing the candidate found — four defects, four fixes

The first three were found by running the candidate; the fourth by the adversarial review of the
first. Each got a test that was RED first. The first three are in commit `dd66a1c`.

### 2.1 `assert_logcat` reported a lost observation as a measured miss

The poll counted successful dumps but never asked whether the **last** dump before the deadline
succeeded. A window whose marker was seen once and whose `adb` then died fell out of the loop and
returned an ordinary `matched:false` with no `status` — a miss that nothing had measured. This is
exactly the transition the activation handoff flagged: *"can see a marker once, then suffer
persistent dump failures and report an ordinary miss."*

Now: `status:"inconclusive"` plus `dumps:{succeeded,failed,lastError}` whenever the final dump
failed, windowed **or** unwindowed; the unwindowed branch counts a nonzero adb exit as a failed
dump instead of discarding it; and `pico_loop` forwards the tool's own hint so automated replanning
cannot chase an unmeasured miss. A miss whose dumps kept succeeding is still a conclusive miss.

Covered by two new cases in `test/logwindow.mjs` driving a `failDumpsAfter` scenario through the
existing recording fixture adb (31/31).

### 2.2 `check_toolchain_updates` called a payload "newer" without comparing it

It keyed off artifact *names*: any public artifact matching a 6.x-looking pattern produced
*"A newer 6.x runtime is publicly downloadable — install it."* On this host — editor 6.1.9,
emulator 6.1.0, with only 6.0.0 payloads public — that advertised an upgrade the host was already
past. The before/after outputs are retained side by side under `evidence/.../sdk/`.

Now the verdict is derived from per-artifact comparison against the installed component:
`parseArtifactVersion` (which refuses to read `20260910` as a version, or `v.12.3` as three parts),
`compareVersions`, and `toolchainUpdateVerdict`, with `comparisons`, `publicUpgradeAvailable`
(`null` when a 6.x-looking payload cannot be compared) and `advertisedLines` in the result. The
live post-fix verdict reads:

> Publicly downloadable 6.x payloads (editor 6.0.0, editor 6.0.0, emulator 6.0.0, emulator 6.0.0)
> are not newer than the installed toolchain (editor 6.1.9, emulator 6.1.0); nothing public to
> install. The channel also advertises the 6.2 line (spatialSDK 6.2.1) with internal-only artifacts
> …, newer than the installed line but not downloadable from here.

Covered by `test/toolchainwatch.mjs` (7 cases), run by `test:sdkselection`.

### 2.3 Capability discovery classified three supported routes as malformed

pico-cli 0.5.0 styles its help with ANSI SGR escapes when `FORCE_COLOR` is set — **and Claude Code
exports `FORCE_COLOR=1` to every child it spawns**, the MCP server included. The styled `Usage:`
heading defeated the usage-section match and the styled `$ pico-cli …` line defeated the route
match, so `knowledge server`, `app watch-crash` and `capture record` — all three genuinely
supported, all three exit 0 — were retained as `unknown: malformed-help`. A knowledge or crash-watch
operation would then have refused on evidence that was an artefact of the parent's terminal.

Fixed at both ends: `stripAnsi` in the classifier, so styling can never hide a usage section; and
`cliChildEnvironment` drops `FORCE_COLOR` and sets `NO_COLOR` for CLI children unless the caller
overrides, so the retained bytes are plain in the first place. Covered by three ANSI cases in
`test/picocli.mjs` (using the exact bytes retained under `~/.pico-mcp/cli/capabilities/0.5.0/`) and
`test/picocli-childenv.mjs`.

### 2.4 `wait_for_log` reported the same lost observation as a conclusive timeout

Found by the adversarial review of §2.1 rather than by running the server: `wait_for_log` is the
sibling primitive the prompts tell an agent to use instead of sleeping, and fixing `assert_logcat`
alone left the two disagreeing about the same failure. Both of its branches were affected, and the
**default** one was the worse of the two: `markerSeen` is only ever assigned on a *successful* read
and is never reset, so a wait that saw the marker once and then lost adb for every remaining poll
skipped the `window && !markerSeen` branch and returned a flat `Timeout:` — a conclusive miss for a
stretch of the wait nothing observed. The unwindowed branch never read the dump's exit code at all,
so a failed dump became `[""]` and read as "no match".

Both now carry the same `lastDumpSucceeded` rule as `assert_logcat`: a miss is conclusive only when
the final dump before the deadline succeeded; otherwise the answer is an explicit *"the observation
was lost"* inconclusive that names the succeeded/failed counts and the last error. Two new cases in
`test/logwindow.mjs`, both RED first (33/33).

## 3. The adversarial review, and what it changed

The diff and the candidate were put through a 133-agent review: four independent read-only lanes
(correctness of the fixes; physical-headset routing; CLI evidence integrity; a completeness critic),
then every finding refuted in parallel by three verifiers with different lenses — correctness,
reachability, already-handled — with a finding surviving only on a minority of refutations. 43
findings were raised; **3 survived**.

| Survivor | Disposition |
|---|---|
| `wait_for_log` still reports a lost observation as a timeout | **fixed** — §2.4 |
| The perf family's capability verdict is chosen by host environment (`PICO_HOME` / `PICO_CLI_PROFILER_ENTRY_PATH`), and the cached record does not say which | **disclosed, not fixed** — see below |
| At review time the candidate had not been discovered by any host; the only host receipt named the old 37.0.0 server | **closed** — §5 and §10: the fast-forward, then a fresh nested `claude -p` receipt against the activated candidate |

The perf one is real and worth writing down: pico-cli 0.5.0 resolves its profiler entry *before*
the utilities check, so an absent `PICO_HOME` throws a different failure than an absent profiler
payload — `unavailable: environment` rather than `unavailable: utilities-not-installed`, with a
different remedy. The capability record caches the verdict without recording which environment
produced it. On *this* host `PICO_HOME` is set, so the remedy in §9 is the right one; on a host that
later loses it, a cached record would keep giving the `setup` answer. Left as a disclosed gap
rather than fixed, because widening the capability record is a design change to a subsystem this
pass was not sent to redesign.

Of the 40 refuted findings, most were refuted correctly — several were snapshots of a mid-flight
tree (a ledger that had not caught up, a version not yet bumped) that this checkpoint has since
overtaken. Two were refuted on *"already documented"* grounds while remaining operationally true,
and both matter enough to restate here rather than leave in a verdict table: the wrong-device
default (§4) and the emulator-only capture routes (§4).

## 4. Physical-headset routing — the map to use when the headset arrives

The single most important fact, verified in source during this pass:

> **`resolveSerial` prefers the emulator.** `src/adb.ts` resolves *explicit serial → sole device →
> sole emulator*. With a headset **and** the emulator attached, `devices.length` is 2, so it falls
> through to the emulator filter and returns **`emulator-5554`**. Roughly two dozen tools take an
> optional `serial` and fall through to it. Before a headset is connected they are correct by luck;
> the moment one is attached, every one of them silently targets the wrong device.

That is why the rule for the headset session is not "be careful" but **"use only the routes that
refuse to act without a serial."** There are six:

| Route | Enforcement | What it does |
|---|---|---|
| `verify_pico_apk` (door `pico_verify_app`) | `serial` **required in the schema**, plus a handler refusal | install → installed-digest check → force-stop → launch → settle → boot id / PID / process start / foreground → PID-scoped log → inspected capture, into an immutable run directory. No emulator constraint anywhere in the file. **The best single headset route on the server.** |
| `capture_frame` | handler refuses an empty serial | `exec-out screencap`, PNG-validated against a capture floor before anything is written |
| `capture_settled` | `z.string().min(1)` | captures until two consecutive byte-identical frames |
| `capture_record` | `device` required in the schema + handler refusal | pico-cli `capture record` |
| `watch_crash` | `device` required in the schema + handler refusal | pico-cli `app watch-crash` |
| `query_scene_anchors` | `z.string().min(1)`, "never inferred" | scene-anchor snapshot |

Two more are safe for a different reason — they **exclude** the emulator by construction rather
than requiring a serial. `deploy_to_device` and `swan_verify_matrix` both route through
`selectPicoDevice`, which drops every `^emulator-` serial *before* probing, then requires exactly
one recognised PICO identity: with one emulator and one headset attached they select the **headset**,
and two PICO-shaped devices return `ambiguous` rather than a guess.

Routes that **cannot** reach a headset at all, and will silently hand back emulator pixels if used
during a headset session: `pico_look` (the doors surface's only capture route — it has no serial
input and targets `emulator-5554`), `measure_perf`, `capture_rig`, `drive_browser`, `webxr_probe`
(module-level hardcoded serials, no input at all), `emulator_look`, `capture_orbit`,
`capture_multiview`, the `gui_*` host-window family, and the `xr_*` gRPC family. `fleet_build` — and
therefore `pico_build_app`, `pico_loop` and `run_spatialbench` above it — hardcodes `emulator-5554`
through install, launch and capture, exactly as the activation handoff warned. `perf_diagnose` /
`pico_perf` and `perf_trace record` substitute the literal `emulator-5554` when `device` is omitted,
so **pass `device` explicitly to every perf call**. None of this was changed here: it is
pre-existing, it is disclosed in the capability matrix, and rewriting two dozen call sites is the
unrestricted cleanup this pass was told not to start.

**Identity acceptance is a substring test, and that is the one thing to check first.**
`classifyDeviceIdentity` rejects on emulator markers (`ro.boot.qemu=1`, or `emulator`/`qemu` in the
model or fingerprint), then accepts **only** if `/pico|swan/i` matches the model *or* the
fingerprint. There is no allowlist and no override — `deploy_to_device`'s own text says so. A real
PICO headset whose model string is an opaque SKU is still accepted when its build fingerprint
carries the usual `Pico/...` brand segment; one where neither string contains `pico` or `swan` would
be **refused**, and the refusal reads like an attestation failure rather than a naming mismatch.
So the first command of the headset session is a read of `ro.product.model` and
`ro.build.fingerprint` — which is exactly what `evidence/.../tooling/headset_identify.py` prints.

Worth knowing for the same session: `navigate_to_scene_target` invalidates its runtime binding when
any online serial is not emulator-shaped, so **attaching the headset disables that tool**; and
`preflight_env`'s emulator check matches only `emulator-\d+`, so a headset-only host reports
`emulator: fail` — alarming, and harmless.

## 5. Per-host discovery

A stdio probe proves transport, not host-plugin discovery; a manifest scan proves neither. Both are
reported separately.

| Host | Version | Registration | Route | Result |
|---|---|---|---|---|
| Claude Code (account-a) | 2.1.273 | `~/.claude-account-a/.claude.json`, user scope, `pico-spatial`, `PICO_MCP_SURFACE=doors` | absolute `node …/PICO-MCP/dist/index.js` | **live tool round-trip**: a nested non-interactive `claude -p` restricted to `mcp__pico-spatial__pico_doctor` called it and returned the real result (`selectedToolchain 6.1`, `spatialbundleVersion 6.1.0.0-rls.25`, `picoCliVersion 0.5.0`). `claude mcp get pico-spatial` reports `✔ Connected`. |
| Claude Code (account-b) | 2.1.273 | `~/.claude-account-b/.claude.json`, same shape | same | registration read; not exercised (one session owns the device lane) |
| Claude Code (default config dir) | 2.1.273 | `~/.claude.json`, `pico-spatial-mcp`, no env → doors | same | registration read |
| Codex CLI | 0.154.0 | `~/.codex/config.toml` (two entries: `pico-spatial` doors, `pico-spatial-mcp` no env), plus `~/.codex-account-a` and `~/.codex-account-b` | same | `codex mcp list` shows `pico-spatial` **enabled**, transport stdio. Listing, not a tool round-trip. |
| Cursor | — | `~/.cursor` holds only a `plugins/` directory from 2026-07-12 | — | **host not installed** (`which cursor` finds nothing, no `Cursor.app`). Unavailable, not failed. |
| Candidate itself | 38.1.0 | direct stdio transport via `evidence/.../tooling/mcpcall.mjs` | child process | `serverInfo 38.1.0`; doors 18 tools; full 255 tools; every tool call in this pass went through it |

**Door schema deltas the candidate brings over the 37.0.0 server that was connected:**
`pico_verify_app` gains `serial` (now **required**) and `activity`; `pico_perf` gains `device`;
`pico_sdk` gains `projectRoot`, `vaultRoot`, `sdkVersion`, `recordPaths`.

## 6. The demo app

| Fact | Value |
|---|---|
| Project | `/Users/sushantsrikrish/AndroidStudioProjects/pico-ui-polish-lab` |
| applicationId | `dev.local.picouipolish.lab` |
| Created by | the candidate's `scaffold_spatial_app` (46 files rebranded), then hand-authored |
| BOM | **6.1.9** — resolving `com.pico.spatial.core:core`, `…ui:platform`, `…ui:foundation`, `…ui:design`, `…sense:sense`, `…tracking:tracking` all at 6.1.9, PICO's Compose fork at 1.2.5, androidx Compose at 1.10.4 |
| Container | `DefaultWindowContainer` (not the scaffold's `DefaultStage`), configured by the `pico.spatial.windowcontainer.{id,defaultsize,resizetype}` meta-data block documented on `SpatialAppScope.DefaultWindowContainer` in the resolved 6.1.9 `foundation` sources |
| UI | `PicoTheme` + `com.pico.spatial.ui.design.Text` and `…design.Button`; no Material, no Material3 |
| Debug UI | none: the scaffold's agent bridge and its demo content files were deleted, and the app has one screen |
| APK | `app/build/outputs/apk/debug/app-debug.apk`, sha256 `5e0871e4cf613073ca73edce544f09c88e4cb61b3de58098ebeb204c1f213b12`, 31,770,062 bytes, `arm64-v8a` only |
| Build | `./gradlew :app:assembleDebug` → BUILD SUCCESSFUL in 12s |

The one interactive element is a real `Button` whose `onClick` mutates Compose state, so the
rendered text changes. It also logs `PolishLab: button tapped taps=N`, which is what makes an
interaction claim checkable against a log window rather than against a screenshot alone.

## 7. Emulator acceptance — admitted, and what it cost

The preserved `render-liveness/1.0.0` tooling was copied out of the paused Mission Replay
repository read-only, with a sha256 manifest (`evidence/.../tooling/render-liveness-1.0.0/
PROVENANCE.sha256`), and adapted by exactly one string — the qemu window title `PICO Emulator -
6.0.0` → `- 6.1.0`, diffed in `ADAPTATION.md`. Its own 22-case host-only self-test passes 22/22 in
the copied location. Thresholds, package targeting and refusal logic are byte-identical to the
originals. The superseded SPR threshold in `runtime_gate.py`'s legacy `gate` mode was **not** used;
only its `raise` mode was. Nothing in the Mission Replay project was built, launched or modified,
and Mission Replay stays paused.

### Install / launch / observe

`verify_pico_apk` with an **explicit** `serial: "emulator-5554"` (required in its schema): the
installed on-device digest equals the local APK digest, PID 10540, foreground is the demo,
`logcatMatch:true` for the app's own readiness line, no crash attributed, one 2160×2158 frame
captured and structurally inspected.

### Admission

| Attempt | Outcome |
|---|---|
| 001 | **FAILED.** Chrome raised itself mid-sample; PxrMetric FPS fell 63 → 33 → 2 over the last six samples; `hostAfterSamplePass`, `earlyVsyncZero`, `pxrMetricAtLeast50` false — while `R1`–`R4` all passed. |
| 002 | FAILED the same way after a re-raise. |
| 003 | **PASSED — all 17 checks.** Zero early-vsync, PxrMetric mean ≥ 50, R1–R4 pass, SPR 22.85/s, installed sha256 and PID 10540 unchanged across the window. |

Both failures are retained. Per the inherited rule these are **occlusion**, not a numeric health
failure: the guest collapse is downstream of the host window being covered, and occlusion permits
unlimited fresh gates. **The single numeric retry was never consumed.** Every later capture in this
pass also rode inside its own freshly admitted gate.

### The thing worth knowing: 21 taps nobody asked for

The first admitted frame read **"State: tapped 21 times"** although this session had delivered no
input. The app was correct — 21 real activations had occurred — so before claiming any interaction
the burst was characterised rather than explained away:

- a 30-second unfiltered watch with no input delivered recorded **0 taps**, so the burst was
  transient and the count was stable at 21;
- it coincided with the `AXRaise`/frontmost sequence, with the emulator's gaze/eye interaction
  toolbar mode active and the virtual ray resting on the panel centre where the button sits.

The emulator's input mode was **not** changed to make the test easier. The consequence is recorded
rather than hidden: a spatial emulator can deliver activations to whatever the ray rests on while a
window is being raised, so an interaction claim on this platform must bind to a *counted delta*
inside a bounded window, never to an absolute count.

### Interaction

1. The button's centre was measured on a **3× crop** of the retained admitted frame, never on a
   downscaled view: crop origin (750,700) in the 1962×2018 frame → global point **(501.7, 452.2)**,
   inside the window's 44 px inset.
2. **Hover only** (`input_capture_v1.py --move`, no button event), then a fresh admitted gate and
   capture. The macOS cursor surface is hidden over emulator content, so hover was verified
   photometrically instead: the button interior brightened by **+12.9 gray** in both text-free
   samples, while two control regions on the same panel moved **0.00**. The pointer was on the
   button, and the count was still 21.
3. **Exactly one click** at the same point. Its own 12-second log window contains exactly one line:
   `PolishLab: button tapped taps=22`, from PID 10540, with the installed sha256 and PID unchanged
   before and after.
4. A post-click admitted gate and capture: **"State: tapped 22 times" / "Tap again (22)"**.

All four frames were opened and judged. Recorded through `record_verification` as `vision_verified`,
`C0_emulator`, capture-bound by sha256 (`evidence/.../emulator/record_verification-interaction-001.json`).

This is interaction acceptance on an emulator. It is **not** a hardware claim: `ro.boot.qemu=1`.

## 8. Per-target acceptance

| Target | Build | Install | Launch | Render (LOOK) | Interaction | Perf |
|---|---|---|---|---|---|---|
| `emulator-5554` | yes | yes, explicit serial | yes, PID observed | **yes — 4 frames** | **yes — +1 tap, counted** | no (profiler payload absent) |
| physical headset | APK is `arm64-v8a`, so it is a plausible target | **not attempted — none attached** | — | — | — | — |
| Linux host | — | — | — | — | — | no host available; nothing run |
| Windows host | — | — | — | — | — | no host available; nothing run |

Fixture emulation of another OS on macOS stays fixture evidence and was not used to fill this table.

## 9. Open lanes, each with its exact next action

**a. The physical headset is not connected.** Nothing was inferred from the name "Space Pro": model,
ABI and runtime must come from the device. To open this lane: connect the headset over USB-C, enable
developer mode and USB debugging on it, and accept the "Allow USB debugging" prompt **inside the
headset**. Then `python3 evidence/2026-09-16-mcp-native-acceptance-001/tooling/headset_identify.py`
prints the real identity and refuses to guess if more than one physical device is attached.

**b. The profiler payload is not provisioned**, so `pico_perf` / `perf_diagnose` / `perf_trace`
cannot run — the CLI itself exits 3 with *"Perf utilities 0.2.0 are not installed."* The MCP does
not install it. The exact command, to be run by the user in their own terminal:

```
/Users/sushantsrikrish/.pico-mcp/cli/versions/0.5.0/node_modules/.bin/pico-cli setup
```

Two cautions, because this command does more than the profiler: run it **without** `--yes` so it
prints its plan first, and read that plan — 0.5.0's `setup` also configures Agent Host plugin
resources for Claude Code / Codex / Cursor / Copilot / Trae, which is host wiring this repository
deliberately never changes on its own. Pre-activation copies of all seven host configuration files
are at `~/.pico-mcp/backups/2026-09-16-native-acceptance/` if anything needs restoring.

**c. Cursor is not installed on this machine**, so its plugin declaration stays structural. Not a
failure; there is no host to load it.

**d. No Linux or Windows host exists here.** The published 252-tool figure for those platforms
remains source-derived, exactly as the accepted checkpoint states.

**e. Emulator camera calibration still predates the current boot** (calibrated 2026-09-04, booted
2026-09-15). Nothing in this pass needed calibrated placement, so it was not run — `pico_doctor
{calibrate:true}` is mutating and would have installed and launched another app. This is a
prerequisite for `measure_placement`, not for anything claimed above.

## 10. Artifacts and rollback

| Artifact | Location |
|---|---|
| Evidence root (ledger, identities, host/cli/sdk/device/emulator receipts, tooling) | `evidence/2026-09-16-mcp-native-acceptance-001/` |
| Four looked-at frames + their 3× crops | `evidence/.../emulator/` |
| Failed gate receipts (attempts 001, 002) | `evidence/.../tooling/render-liveness-1.0.0/package-targeted-tooling-001/` |
| Full 55-gate battery on the released 38.1.0 tree — **55/55, 0 failed** | `evidence/.../integration/battery-38.1.0-final.log` and `.summary.txt` |
| The earlier battery run, superseded and retained | `evidence/.../integration/battery-38.1.0.log` — 54/55; its one failure was `test:docsmeta` telling the truth about a hand-edited `package.json` whose `package-lock.json` still read 38.0.0, which is why the release commit used `npm version` instead |
| Host configuration backups (7 files, outside the repo) | `~/.pico-mcp/backups/2026-09-16-native-acceptance/` |
| Rollback recipe | `evidence/.../host/ROLLBACK.md` |
| The three retained 38.0.0 archives | untouched under `evidence/2026-09-15-cli050-sdk61-evolution-impl-001/release/` |

Activation edited **no** host configuration file: all six registrations already name the absolute
path `node /Users/sushantsrikrish/PICO-MCP/dist/index.js`, so activation is what that path contains.
Rollback is `git reset --hard 4478238…` plus `npm run build` in the main checkout, then a host
restart. A running MCP server keeps serving the `dist/` it loaded at startup, so **neither
activation nor rollback reaches a process that is already running** — every host must be restarted
or opened fresh to pick either up.

## 11. Handoff to the spatial-polish chat

The demo project `/Users/sushantsrikrish/AndroidStudioProjects/pico-ui-polish-lab`
(`dev.local.picouipolish.lab`) is the safe, isolated place for that work to continue. It is on BOM
6.1.9, it builds, it is installed on `emulator-5554`, and its window renders and responds. It is not
the app skeleton and not any shipping app; changing it cannot affect either.

Three things that chat should inherit rather than rediscover:

1. **Take the hover measurement photometrically.** The macOS cursor surface is hidden over emulator
   content, so "the ray is on the control" is proved by a local brightness delta on the control
   against a zero delta on a control region of the same panel — not by a cursor dot.
2. **Bind interaction claims to a counted delta in a bounded window**, because the emulator can
   deliver activations of its own while a window is being raised (§7).
3. **Every capture rides inside its own freshly admitted gate**, and an occlusion failure is not a
   numeric failure — re-raise and collect a complete fresh gate, as often as it recurs.

### Next prompt

> Continue the PICO spatial-polish work in `/Users/sushantsrikrish/AndroidStudioProjects/pico-ui-polish-lab`
> (`dev.local.picouipolish.lab`, Spatial SDK BOM 6.1.9, `DefaultWindowContainer` + SpatialUI). Read
> `docs/findings/CLI050_NATIVE_ACCEPTANCE_CHECKPOINT.md` §7 and §11 in the worktree
> `.worktrees/cli050-native-acceptance-2026-09-16` first, and reuse the admitted-gate, 3×-crop and
> hover-delta discipline recorded there. Build the reusable SpatialUI components and the showcase
> screen per `docs/handoffs/2026-09-16-pico-next/SPATIAL_POLISH_PLAN.md`, on a new branch, unmerged.
> Only one session may own the emulator at a time — confirm this one has released it before any
> install, launch or capture. Mission Replay stays paused; do not touch it or any unrelated app.

## 12. What this checkpoint does not claim

- **No hardware.** No physical headset was attached, so nothing here is `device_verified` and the
  Swan/headset lane is untouched.
- **No perf measurement.** The profiler payload is absent; `unavailable` is a capability fact, not a
  measurement.
- **No cross-platform result.** Linux and Windows remain unrun.
- **No claim about other apps.** Only `dev.local.picouipolish.lab` was installed, launched, driven
  or captured.
- **Emulator numbers are the emulator's.** The render-liveness thresholds establish bounded app
  liveness on this guest; they are not application FPS, not compositor health, and not evidence
  about a physical device's refresh rate.
