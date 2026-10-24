# Bounded agent iteration candidate — 2026-10-23

This source candidate is on `feature/cli-agent-iteration-2026-10-23`, based on main `1157f33ad2d3934595a3ebaafe4d3fbfc7e1ce36`. It adds one opt-in `pico_interaction` tool to either MCP surface. The installed registration remains on main. Stage 1 remains separately at `3b09ac5db919afef612558f3fdb5302b2c55e3eb`; Stage 2 and Mission Replay restrictions are unchanged. No merge, push, version release or activation occurred.

The loop is **observe → semantic action → independent assertion → capture → source-bound rebuild → reconnect → replay**. The dedicated fixture completed this loop on `emulator-5554` after the user confirmed exclusive emulator use and authorized native work. Root inspected the rendered initial state, action result and source-revision-3 replay result. This is bounded emulator evidence, not simulator parity, physical hand/controller input or interactive host conformance. The emulator was already running; no boot or restart was issued. Native work is drained and [root ownership released](../../evidence/2026-10-24-agent-iteration-native/RELEASE.json), with the fixture and emulator left running.

## Runnable source-checkout example

```sh
npm run build
node scripts/agent-iteration-example.mjs describe
npm run test:interaction
```

`describe` uses a fresh stdio connection and works offline. `PICO_MCP_INTERACTION=1` adds the candidate tool; default published surfaces remain unchanged. The protocol fixtures use synthetic PNG bytes and fake app/device state. They prove host behavior and wire delivery, not a rendered app or a host image viewer.

With existing JDK, Android SDK, Gradle and cached dependencies, build the dedicated fixture:

```sh
JAVA_HOME=/absolute/existing/jdk \
  node scripts/agent-iteration-example.mjs build \
  --project /absolute/path/to/examples/agent-iteration-fixture \
  --gradle /absolute/existing/gradle-8.13/bin/gradle
```

The adapter uses offline Gradle, a project-local user home, no daemon, no automatic SDK/JDK download and bounded owned-child cleanup. Missing dependencies fail. A policy seals the reviewed single-module scripts while allowing `app/src` edits. Extra modules, edited scripts, injected JVM options or untracked Gradle configuration refuse the binding. Resolved dependencies/compiler/plugins/JDK/SDK/Gradle/signing inputs are collected before and after compilation and checked for byte/generation continuity. This is bounded fixture provenance, not general Stage 2 support or a hermetic host claim.

With native ownership, an explicit emulator running and the exact debug APK installed/launched through the official CLI, the exercised native example is:

```sh
PICO_ADB=/absolute/existing/adb ADB_PATH=/absolute/existing/adb \
  node scripts/agent-iteration-example.mjs scenario \
  --native-authorized --serial emulator-N --apk-sha INSTALLED_DEBUG_APK_SHA256
```

The flag records intent; it grants no ownership or boot permission. Set both ADB variables to the same existing executable before starting the session: MCP reads `PICO_ADB`, while CLI 0.6.1 reads `ADB_PATH`. The app must begin hidden at counter zero. The [scenario](../../examples/agent-iteration-fixture/scenario.json) names only `panel.show` on `fixture.panel`. Open and judge its returned frame before recording a visual claim. Shell capture can be inconclusive for XR layers; an ACK does not resolve an inconclusive image.

The fixture requests `limits.captureSettleMs: 2500`. The optional interval defaults to zero, is capped at 3000 ms, consumes the existing deadline and remains cancellable. Target/state are rechecked after waiting; a frame predating the post-wait capture request is refused. This is a timing accommodation, not render readiness. On this emulator the immediate action frame still showed the initial state, and the immediate rebuild frame showed only the room even with settling. Both failed LOOKs are retained. Later read-only captures showed the expected state without resending either action.

After a failed LOOK, capture again using the current installed APK hash:

```sh
PICO_ADB=/absolute/existing/adb ADB_PATH=/absolute/existing/adb \
  node scripts/agent-iteration-example.mjs capture \
  --native-authorized --serial emulator-5554 \
  --apk-sha 9e311dc104d70a3997832162d6597d45805692f22f729ca869c86bdff45d9a12
```

This mode opens a bound session, calls existing `pico_look` with the explicit serial, rechecks identity/state, and retains the hash-checked frame in the session. It sends no semantic action. It was executed successfully; the returned source-revision-3 frame was opened and recorded with `record_verification` in a worktree-local ledger. A future install requires its own current hash.

For the later rebuild/replay experiment, edit the title in `content/HomePage.kt` and invoke `replay` with the previous installed APK hash and existing Gradle path:

```sh
JAVA_HOME=/absolute/existing/jdk \
  PICO_ADB=/absolute/existing/adb ADB_PATH=/absolute/existing/adb \
  node scripts/agent-iteration-example.mjs replay \
  --native-authorized --serial emulator-N --apk-sha PREVIOUS_INSTALLED_DEBUG_APK_SHA256 \
  --project /absolute/path/to/examples/agent-iteration-fixture \
  --gradle /absolute/existing/gradle-8.13/bin/gradle
```

This exercised example explicitly consents to stopping/replacing/relaunching only the debug fixture, preserves app data, requires a different APK and new Bridge generation on the same boot, then replays the scenario. No AVD snapshot, data clear or automatic action retry occurs. Make a new source edit before another replay: an unchanged APK is deliberately refused.

The example releases only a drained MCP session. Uncertainty retains the target hold. The opt-in `watch` action accepts at most five cycles and 30 minutes, coalesces edits and excludes generated outputs. Its deadline/cancellation reaches the current cycle; measured time includes owned-child drain after the requested deadline. Default iteration is one cycle.

## Before and after

| Area | Before | Candidate |
| --- | --- | --- |
| CLI contracts | Usage fragments and package identity | Complete help plus selected utility/config identity; unknown versions inherit no option declarations |
| Workflow lifecycle | Existing CLI and receipt foundations | CLI stays authoritative; scenario references exact retained read bytes without advancing revisions |
| Target | Some legacy defaults | Explicit emulator/package/APK/boot/PID/start/generation rechecked before mutation and attribution |
| LOOK | Door omitted serial | Optional serial forwards unchanged; historical omission keeps its default; sessions always name a target |
| Action | Existing Bridge primitives | Debug-only nonce/revision/deadline/ACK and independent semantic readback |
| Retry | Separate primitives | Possibly applied/lost-ACK actions become `in_doubt`; no resend or uncertain release |
| Build | Existing V1 receipts | Dedicated fixture binds source and actual resolved inputs; failed builds cannot reuse old APKs |
| Hosts | Existing registrations | Ordinary MCP text/image/resource results and isolated configuration candidates |

`semanticinteraction.ts` implements the proposed interaction seam; existing `interaction.ts` remains the legacy tools module. Target binding reuses device/receipt parsers. Scenarios implement their own explicit-target semantic assertions instead of calling legacy `assert_scene`. The new fence follows existing exclusive-owner/drain principles in a separate target scope. V1 receipts, CLI run ownership and Stage 2 meanings are unchanged.

The fence's scope is `interaction-session-only`. It coordinates upgraded callers sharing the fence store. Legacy tools, manual writers and external CLI processes are not technically blocked; observable interference invalidates attribution. Owner death or elapsed time never transfers a fence. Android `run-as` protects against ordinary app UIDs, not an adb-authorized actor able to rewrite private evidence.

## Capability matrix

| Capability | Implemented | Host evidence | Native runtime tested | Rendered frame reviewed | Remaining boundary |
| --- | --- | --- | --- | --- | --- |
| CLI help/selection | Yes | Real help and negative fixtures | Stop/install/launch through CLI 0.6.1 | Not applicable | Other CLI operations/platforms; live WorkflowRun reference |
| Target/fence | Yes | Mixed devices, drift, competing owners, cancellation | Exact emulator/boot/APK/process binding; drained release | Not applicable | Competing native writers remain fixture-only; legacy writers are not fenced |
| `panel.show`, ACK/readback | Yes | Protocol/shell/negative fixtures; JVM state test | Two completed actions across a rebuild | Yes, later captures | Ordinary-UID denial and release enforcement were not tested live |
| Fresh frame/MCP delivery | Yes | Synthetic attribution/tamper and public protocol cases | Real capture; public MCP recapture | Initial, source 2 and source 3 frames | Immediate frames failed LOOK; timing is not readiness; host UI display untested |
| Source-bound debug build | Yes | Resolved closure/failure tests and actual offline builds | New APK installed; new generation on same boot; replay | Source revision 3 visible | Dedicated fixture provenance only; broader Stage 2 unchanged |
| Bounded scenario/watch | Yes | Full injected public-service loop and negatives | Scenario and one rebuild/replay cycle | Yes, later captures | Multiple watch cycles/cancellation not tested native |
| Generic MCP stdio | Yes | Candidate process, wire cancellation and retained uncertainty regression | Not applicable | No | Specific host UI behavior |
| Packed candidate | Yes | Host follow-up `bb4671fe…` tarball: standalone temporary install and offline stdio discovery on both surfaces; native-phase `9265d1e…` preserved | Source checkout ran native; packed copies did not | No packed-host LOOK | Other operating systems and host activation |
| Claude/Codex/Gemini | Templates and isolated conformance adapter | Claude and scoped-preapproved Codex: discovery/calls/historical image; Claude wire cancellation and same-process reconnect; Codex transport closure and fresh-session recovery | No new native operations | Both models transcribed the retained frame; root checked it | Human host image viewer, unrestricted template admission, Codex same-process reconnect unverified; Gemini account/startup blocked |
| Hand/controller, room/sensor replay | No | None | No | No | Separate backend and authority |

See [CLI observations](CLI_AGENT_CONTRACTS.md), [host configurations](AGENT_ITERATION_HOST_CONFIGS.md), [actual host trials](AGENT_ITERATION_HOST_TRIALS.md), and the [fixture README](../../examples/agent-iteration-fixture/README.md).

## Validation and retained identities

Local source commits are `01180db` (CLI contracts) and `9ca38de` (interaction loop). The [independent review](../../evidence/2026-10-23-agent-iteration/REVIEW_RESULT.json) reports no remaining material source findings, including its packaging follow-up. The reviewer did not independently rerun tests or perform native operations.

The [initial host validation manifest](../../evidence/2026-10-23-agent-iteration/VALIDATION.json) retains log hashes and distinguishes its final build from earlier regression runs. That host snapshot passed interaction **74/74**, observation **83/83**, CLI contract/observation cases **33/33**, lint **63/63**, docs **26/26**, smoke **12 checks**, and tarball checks. Earlier receipt **337/337**, revision **327/327**, bridge **630/630**, doors and emulator regression gates passed; the latter reports one skipped test. The native follow-up adds transport/settling coverage; its interaction gate passes **82/82**. The full battery was not run and three broader gates remain failing as described below.

The [rebuild experiment](../../evidence/2026-10-23-agent-iteration/REBUILD_EXPERIMENT.json) retains both initial host builds. The only changed authored input was the title in `HomePage.kt`. Each build retained 12,342 matching before/after resolved input identities and released its project owner. APK SHA-256 changed from `05edb1f0d71e7e3f4cfc564bfa34f997cdbeac10291ee69634cdf8cd143c970f` to `24704bdee8d5547b09621d48e073abe33741b94a42627d2f6ed9afe091956e04`. This initial record proves host compilation. The later native follow-up adds install, generation reconnect, replay and looked-at response for source revision 3.

[Initial artifact identities](../../evidence/2026-10-23-agent-iteration/ARTIFACTS.json) are historical: their `c75843e…` tarball predates the native fixes. The [native follow-up artifact manifest](../../evidence/2026-10-24-agent-iteration-native/ARTIFACTS.json) pins the current server, APK, rendered evidence and replacement tarball SHA-256 `9265d1e35152f31869cc0ff1be590a156d9642ae907fbd54d9b4a2fac08cbdbb`. The exact replacement bytes passed the installed-artifact gate and remain local, unpublished at version 38.1.0. [Follow-up validation](../../evidence/2026-10-24-agent-iteration-native/VALIDATION.json) records interaction **82/82**, observation **83/83**, lint **63/63**, docs **26/26**, and the tarball gate. Native execution used the source checkout. APKs, frames, tarballs and complete resolved-input inventories remain local and gitignored; source, manifests and raw text evidence are committed. Raw PTY/TAP whitespace is preserved; an unfiltered whitespace check is not claimed.

The [native run report](AGENT_ITERATION_NATIVE.md) links authorization, exact target/artifact identities, two failed immediate LOOKs, later successful captures, the uncertainty reconciliation and final release. The later [host trials](AGENT_ITERATION_HOST_TRIALS.md) add real Claude/Codex consumption of that historical frame and measured cancellation/recovery behavior. They grant no fresh native acceptance, and semantic `panel.show` does not establish hand/controller usability. The original native-phase tarball above remains preserved; the host follow-up retains its own checked payload and identities.

The host follow-up passes interaction **85/85** (including ten synthetic process-cleanup cases), lint **63/63**, docs **26/26**, and standalone tarball acceptance. Its [artifact manifest](../../evidence/2026-10-24-agent-iteration-hosts/ARTIFACTS.json) selects SHA-256 `bb4671fe2c9f6f6a5d1df0485ce55590c9edcad833487a4cb46c589721fc0499`. Production server source and build identities are unchanged from the native follow-up; the new payload adds the manual host harness and explicit tarball-install isolation. The actual host trials used the source checkout, while the packed copy passed separate offline discovery checks.

## Known failures and incident

The full CLI gate fails one detached-child output-cap cleanup assertion and its parent subtest (158/160 TAP tests pass). Its process-environment scan exceeds 4 MiB; the same failure reproduces in an isolated compile of unchanged main. The final CLI contract segment was run separately and passed.

Knowledge lifecycle has four failures (23/27 pass), all directly reproduced on isolated main. The unchanged process-table provider exceeds its 250 ms budget. Distribution adoption has three retirement failures (40/43 pass) on the same unchanged provider path; this common cause is an inference, because those exact distribution cases were not rerun on main. [The diagnosis and cleanup record](../../evidence/2026-10-23-agent-iteration/cli/LIFECYCLE_TRIAGE.json) distinguishes this timeout from the separate 4 MiB sweep limit. Only freshly identity-checked, task-owned fixtures/workers were signalled. No unrelated runner fix or weaker ownership check was introduced.

Official scaffold creation unexpectedly refreshed shared SDK 6.1 templates despite selecting the existing SDK and passing no setup/update command. This crossed the SDK-preservation boundary. Scaffold commands stopped, affected paths/output were retained, and no speculative rollback occurred. The [incident record](../../examples/agent-iteration-fixture/evidence/scaffold-observation.json) states that prior identity was unavailable. Later dependencies used the authorized worktree-local cache. No native work occurred during that host phase. The separately authorized native follow-up changed only the dedicated fixture and retained evidence; no SDK/setup/configuration repair or headset fallback was used.
