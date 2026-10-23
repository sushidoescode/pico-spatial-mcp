# Bounded agent iteration candidate — 2026-10-23

This source candidate is on `feature/cli-agent-iteration-2026-10-23`, based on main `1157f33ad2d3934595a3ebaafe4d3fbfc7e1ce36`. It adds one opt-in `pico_interaction` tool to either MCP surface. The installed registration remains on main. Stage 1 remains separately at `3b09ac5db919afef612558f3fdb5302b2c55e3eb`; Stage 2 and Mission Replay restrictions are unchanged. No merge, push, version release or activation occurred.

The loop is **observe → semantic action → independent assertion → capture → source-bound rebuild → reconnect → replay**. The implementation and host fixtures do not establish emulator or simulator parity. No emulator was available at the initial doctor check. Actual native ownership/release and any necessary start authority have not been supplied for this candidate.

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

After a separately recorded native handover, with an explicit emulator already running and the exact debug APK installed/launched through the official CLI, the **unexecuted** native example is:

```sh
node scripts/agent-iteration-example.mjs scenario \
  --native-authorized --serial emulator-N --apk-sha INSTALLED_DEBUG_APK_SHA256
```

The flag records intent; it grants no ownership or boot permission. The app must begin hidden at counter zero. The [scenario](../../examples/agent-iteration-fixture/scenario.json) names only `panel.show` on `fixture.panel`. Open and judge its returned frame before recording a visual claim. Shell capture can be inconclusive for XR layers; an ACK does not resolve an inconclusive image.

For the later rebuild/replay experiment, edit the title in `content/HomePage.kt` and invoke `replay` with the previous installed APK hash and existing Gradle path:

```sh
JAVA_HOME=/absolute/existing/jdk \
  node scripts/agent-iteration-example.mjs replay \
  --native-authorized --serial emulator-N --apk-sha PREVIOUS_INSTALLED_DEBUG_APK_SHA256 \
  --project /absolute/path/to/examples/agent-iteration-fixture \
  --gradle /absolute/existing/gradle-8.13/bin/gradle
```

This unexecuted example explicitly consents to stopping/replacing/relaunching only the debug fixture, preserves app data, requires a different APK and new Bridge generation on the same boot, then replays the scenario. No AVD snapshot, data clear or automatic action retry occurs.

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
| CLI help/selection | Yes | Real read-only observations and negative fixtures | No mutations | No | Runtime semantics and platform differences |
| Target/fence | Yes | Mixed devices, drift, competing owners, cancellation | No | No | Actual emulator and interference |
| `panel.show`, ACK/readback | Yes | Protocol/shell/negative fixtures; JVM state test | No | No | Android enforcement and visible response |
| Fresh frame/MCP delivery | Yes | Synthetic-image attribution and tamper tests | No | No | Real capture, host display and LOOK |
| Source-bound debug build | Yes | Two actual builds around a title edit; changed source/APK hashes; closure/failure tests | No install | No | Reconnect/replay on emulator |
| Bounded scenario/watch | Yes | Full injected public-service loop and negatives | No | No | End-to-end native acceptance |
| Generic MCP stdio | Yes | Candidate process and SDK protocol fixtures | Not applicable | No | Specific host UI behavior |
| Packed candidate | Yes | Exact policy bytes; offline stdio discovery from temporary install on both surfaces | No | No | Other operating systems and host activation |
| Claude/Codex/Gemini | Config templates | Syntax, installed help/source contracts | No | No | Discovery, calls, trust, cancellation and image display all untested |
| Hand/controller, room/sensor replay | No | None | No | No | Separate backend and authority |

See [CLI observations](CLI_AGENT_CONTRACTS.md), [host configurations](AGENT_ITERATION_HOST_CONFIGS.md), and the [fixture README](../../examples/agent-iteration-fixture/README.md).

## Validation and retained identities

Local source commits are `01180db` (CLI contracts) and `9ca38de` (interaction loop). The [independent review](../../evidence/2026-10-23-agent-iteration/REVIEW_RESULT.json) reports no remaining material source findings, including its packaging follow-up. The reviewer did not independently rerun tests or perform native operations.

The [validation manifest](../../evidence/2026-10-23-agent-iteration/VALIDATION.json) retains log hashes and distinguishes final-build runs from earlier regression runs. Final-build results: interaction **74/74**, observation **83/83**, CLI contract/observation cases **33/33**, lint **63/63**, docs **26/26**, smoke **12 checks**, and tarball checks passed. Earlier receipt **337/337**, revision **327/327**, bridge **630/630**, doors and emulator regression gates passed; the latter reports one skipped test. The full battery was not run and three broader gates remain failing as described below.

The [rebuild experiment](../../evidence/2026-10-23-agent-iteration/REBUILD_EXPERIMENT.json) retains both successful host builds. The only changed authored input was the title in `HomePage.kt`. Each build retained 12,342 matching before/after resolved input identities and released its project owner. APK SHA-256 changed from `05edb1f0d71e7e3f4cfc564bfa34f997cdbeac10291ee69634cdf8cd143c970f` to `24704bdee8d5547b09621d48e073abe33741b94a42627d2f6ed9afe091956e04`. This proves host compilation of the source change; install, generation reconnect, action replay and rendered response remain pending.

[Exact artifact identities and paths](../../evidence/2026-10-23-agent-iteration/ARTIFACTS.json) cover CLI 0.6.1, server source/output, policy, debug APKs, the pre-title-edit release packaging checkpoint, build records and the retained tarball. The local tarball is byte-identical to the artifact that passed the installed-artifact gate; it remains unpublished at version 38.1.0. APKs, the tarball and complete resolved-input inventories remain local and gitignored. Source, manifests and raw text evidence are committed. Raw PTY/TAP whitespace is preserved; an unfiltered whitespace check is not claimed.

Native acceptance needs the actual outgoing-owner release, a recorded acquisition and any necessary emulator-start permission. Root must then target the authorized emulator, perform the finite scenario, inspect its rendered frame, rebuild and replay. Interactive Claude/Codex/Gemini discovery, trust, cancellation and image-display trials remain separately unrun. Semantic `panel.show` does not establish hand/controller usability.

## Known failures and incident

The full CLI gate fails one detached-child output-cap cleanup assertion and its parent subtest (158/160 TAP tests pass). Its process-environment scan exceeds 4 MiB; the same failure reproduces in an isolated compile of unchanged main. The final CLI contract segment was run separately and passed.

Knowledge lifecycle has four failures (23/27 pass), all directly reproduced on isolated main. The unchanged process-table provider exceeds its 250 ms budget. Distribution adoption has three retirement failures (40/43 pass) on the same unchanged provider path; this common cause is an inference, because those exact distribution cases were not rerun on main. [The diagnosis and cleanup record](../../evidence/2026-10-23-agent-iteration/cli/LIFECYCLE_TRIAGE.json) distinguishes this timeout from the separate 4 MiB sweep limit. Only freshly identity-checked, task-owned fixtures/workers were signalled. No unrelated runner fix or weaker ownership check was introduced.

Official scaffold creation unexpectedly refreshed shared SDK 6.1 templates despite selecting the existing SDK and passing no setup/update command. This crossed the SDK-preservation boundary. Scaffold commands stopped, affected paths/output were retained, and no speculative rollback occurred. The [incident record](../../examples/agent-iteration-fixture/evidence/scaffold-observation.json) states that prior identity was unavailable. Later dependencies used the authorized worktree-local cache. No emulator boot, APK install/launch, headset fallback or rendered-frame claim followed.
