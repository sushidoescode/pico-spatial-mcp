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

For the later rebuild/replay experiment, edit the title in `content/HomePage.kt` and invoke `replay` with the previous installed APK hash and existing Gradle path. This explicitly consents to stopping/replacing/relaunching only the debug fixture, preserves app data, requires a different APK and new Bridge generation on the same boot, then replays the scenario. No AVD snapshot, data clear or automatic action retry occurs.

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
| Source-bound debug build | Yes | Actual APK compilation and closure/failure tests | No install | No | Reconnect/replay on emulator |
| Bounded scenario/watch | Yes | Full injected public-service loop and negatives | No | No | End-to-end native acceptance |
| Generic MCP stdio | Yes | Candidate process and SDK protocol fixtures | Not applicable | No | Specific host UI behavior |
| Claude/Codex/Gemini | Config templates | Syntax, installed help/source contracts | No | No | Discovery, calls, trust, cancellation and image display all untested |
| Hand/controller, room/sensor replay | No | None | No | No | Separate backend and authority |

See [CLI observations](CLI_AGENT_CONTRACTS.md), [host configurations](AGENT_ITERATION_HOST_CONFIGS.md), and the [fixture README](../../examples/agent-iteration-fixture/README.md). Final validation and artifact identities are retained with the candidate evidence.

## Known failure and incident

The preexisting detached-child sweep cleanup test fails here because its bounded process-environment scan exceeds 4 MiB. It also fails in an isolated compile of unchanged main. The candidate retains the sanitized diagnosis and does not call the entire CLI gate green or modify that unrelated runner.

Official scaffold creation unexpectedly refreshed shared SDK 6.1 templates despite selecting the existing SDK and passing no setup/update command. This crossed the SDK-preservation boundary. Scaffold commands stopped, affected paths/output were retained, and no speculative rollback occurred. The [incident record](../../examples/agent-iteration-fixture/evidence/scaffold-observation.json) states that prior identity was unavailable. Later dependencies used the authorized worktree-local cache. No emulator boot, APK install/launch, headset fallback or rendered-frame claim followed.
