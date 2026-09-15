# CLI 0.5.0 and SDK 6.1 MCP evolution handoff

Date: 2026-09-15. Status: screened and planned; implementation and release acceptance remain open.

The next work is in **PICO-MCP**, keeping its workflow orchestration, SDK provenance and evidence verification useful alongside the official CLI. Mission Replay is paused by the user. This checkpoint does not upgrade an application, activate a different CLI, or certify SDK 6.1 rendering.

## Start here

1. Read [AGENTS.md](../AGENTS.md), this handoff, and the [implementation plan](superpowers/plans/2026-09-15-cli050-sdk61-evolution.md).
2. Use the [fresh-chat prompt](CLI_050_SDK61_FRESH_CHAT_PROMPT_2026-09-15.md) to execute the work in a new conversation.
3. Inspect actual HEAD and local changes before editing. The audited source is `308c898e9c33975b5a21ecb78fed245fab17a0ed`, `main`, package version `37.0.0`; tracked files were clean at audit start. Later handoff commits contain planning/evidence only.

## Global constraints

- Work in `/Users/sushantsrikrish/PICO-MCP`. Preserve existing implementation and all prior evidence.
- Begin each fresh session with read-only `pico_doctor {}`. Its calibration failure does not prevent useful host-only implementation or tests.
- Preserve the exact managed CLI contract in AGENTS.md. No changes to the global CLI, PATH, host plugin wiring or utility setup as incidental effects of inspection, startup or registration.
- Mission Replay remains paused. Do not edit, build, install or migrate that application, or treat its old native evidence as SDK 6.1 acceptance.
- Never restart or move/resize the emulator, kill unrelated processes, change Wing, push, or rewrite history. Root alone may operate emulator-5554 if later work actually requires it and its existing gates admit the action.
- No emulator account sign-in or copying browser credentials for this work. An authentication-dependent optional service must be identified by its actual error; it does not block independent host work.
- Build current source before tests that import `dist/`. Preserve failures; do not lower evidence, health or acceptance thresholds.
- Exact SDK declarations require version-matched provenance. Host SDK version, application BOM, Maven artifact versions and knowledge-package revision are separate facts.
- Preserve typed MCP results, bounded execution, immutable artifacts, explicit target identity and the LOOK requirement. Exit zero, a help listing and a nonempty file cannot establish visual acceptance.
- Use fresh evidence paths and reviewable local commits. No release-version bump until the implementation scope and compatibility effect justify it.

## What was actually established

| Item | Observation | Evidence / limit |
|---|---|---|
| Official CLI release | Registry latest was **0.5.0**, published 2026-09-10T04:15:42.541Z | [Registry snapshot](../evidence/2026-09-15-cli050-sdk61-evolution-audit-001/REGISTRY_001.json), fetched 2026-09-15T09:03:54Z; [release identity](../evidence/2026-09-15-cli050-sdk61-evolution-audit-001/RELEASE_IDENTITY_001.json) |
| Current MCP selection | Managed cache **0.4.4**, with no freshness lookup in default doctor | [Doctor](../evidence/2026-09-15-cli050-sdk61-evolution-audit-001/PICO_DOCTOR_001.json). A later operation can resolve differently; inspect again in the new chat. |
| Host toolchain | 0.13, 6.0 and 6.1 installed; toolchain selected **6.1**, spatialbundle **6.1.0.0-rls.25** | Same doctor. Legacy preflight simultaneously reported SDK path ending `/sdk/0.13`: an inconsistency to fix. |
| Calibration | Stale after boot at 2026-09-15T08:33:50.551Z; calibration dated 2026-09-04 | Same doctor. No calibration, input, install, launch, recording or emulator lifecycle action was performed in this audit. |
| CLI package integrity | Registry SHA512 SRI matched downloaded 0.4.4 and 0.5.0 tarballs | Release identity file. Archives remain local, ignored by Git. |
| Advertised help traversal | **69 → 91 visited paths**, 25 added, 3 removed; includes group nodes | [Original comparison](../evidence/2026-09-15-cli050-sdk61-evolution-audit-001/HELP_COMPARISON_001.json), [retained comparison](../evidence/2026-09-15-cli050-sdk61-evolution-audit-001/HELP_COMPARISON_002.json). This is not a count of executable leaf commands. |
| Help evidence quality | Retained run has 162 invocations: 160 help calls plus two version calls; zero timeouts or truncated outputs | [Invocation index](../evidence/2026-09-15-cli050-sdk61-evolution-audit-001/RAW_HELP_INDEX_002.json). Six calls exited nonzero because profiler utilities were absent. |
| Test and native status | No MCP build, regression battery, app build or rendered-frame acceptance in this planning audit | Findings from source inspection are labeled accordingly below. Do not report the audited source as passing all gates. |

Public release authority: the [PICO CLI npm registry record](https://registry.npmjs.org/@picoxr%2fpico-cli), supported by integrity-checked published package contents and locally executed version/help output. The screenshot alone is not the release proof. The packaged README is unchanged between releases and still describes old MCP commands; prefer actual help and registrations for exact syntax.

The original comparator retains only help hashes and deletes its scratch installation. A second, explicitly recorded audit-only copy added raw output/status retention, preserving the original traversal and invocation restrictions. Both runs used isolated package installs with lifecycle scripts disabled. Neither activated the MCP's CLI cache or ran utility setup. Original comparator source is unchanged. See the [second run receipt](../evidence/2026-09-15-cli050-sdk61-evolution-audit-001/HELP_COMPARISON_RUN_002.json).

## Required CLI compatibility work

| Surface | Actual change / current gap | Next implementation and acceptance |
|---|---|---|
| Knowledge transport | 0.5.0 advertises `knowledge server`, `doctor`, `list`, `pull`. Published registrations replace spaced `mcp dev-knowledge`; retained aliases use colon tokens. `src/knowledge.ts` still defaults to the old spaced command. | Use canonical `knowledge server` for 0.5; test historical support and preserve external command configuration. This is a source-confirmed registration change, independently supported by help traversal; a live server handshake is still pending. |
| Crash watcher | 0.5.0 advertises `--monitor-timeout <seconds>`, default 30. The wrapper claims no duration flag and always reports requested seconds, including early exit. | Pass the supported native timeout, retain a separate outer watchdog, report actual elapsed time and coverage. An early clean exit cannot prove the requested watch window. Inspect launch-wait versus watch semantics. |
| Performance | 0.5.0 advertises `perf live`; the published profiler changed 0.1.0 → 0.2.0. MCP still calls `perf monitor run --app … -o …`. | Establish exact argv and saved-report behavior from vendored profiler declarations plus provisioned help when available. Validate report schema and insufficient-data states; missing utility is a capability gap, not successful profiling. |
| Trace envelopes | Current `src/perftrace.ts` does not parse the new load text or unwrap query envelope rows. | Use explicit supported structured output for load, validate `data.sessionId`, and unwrap/validate query `data.rows` with session identity. Preserve raw output and actual error envelopes. |
| Recording | CLI help increases advertised `-t` range from 1–180 to 1–1800. MCP only checks that the result is a nonempty regular file. | Keep a conservative MCP default/limit until real route behavior is proven. Verify container, measured duration, stream dimensions, hash and capture route. Advertised maximum is not proof that a single device recording supports it. |
| Project context | `project context doctor` changes from `--project`, `--plugin`, `--tool` to project cwd and `--agent-tool`; context readiness becomes more prominent. | Audit any instructions/adapters, preserve explicit cwd, and separate inspection from repair. Do not run a context fixer across existing application repositories. |
| CLI capability probe | Current managed probe list includes old knowledge/perf commands. Nonzero, generic help and unavailable utility output need different meanings. | Record package identity, operation-specific support, argv/status/raw-help hashes and unavailable reasons. Startup remains cache inspection; runtime dispatch must not call an unsupported operation because a version string parsed. |
| Emulator status consumer | CLI 0.5 still supplies the expected envelope, but current preflight can pass `SUCCESS` with failed execution and does not require `tool_name: emulator.status`. | Require consistent execution/status/tool identity. Preserve `PARTIAL` with exit 4 as a warning; this row is never native app acceptance. |

New advertised areas also include SpatialML onboarding/model/pipeline commands, `plugin install`/`uninstall`, and additional Editor/project grouping. Published Editor bootstrap code now provides a managed production/revision controller and bundle scene sidecars. Add discovery/routing and documented capability status first. Only add an MCP execution surface when it composes those operations into a useful, tested workflow. Do not turn this release into an unbounded SpatialML product, another Editor controller, or a duplicate plugin manager.

The source-derived perf invocation candidate is `perf live run --package PKG --duration SEC --device SERIAL --save --output PATH`. Its utility resolution now requires an absolute `PICO_HOME` unless an explicit profiler entry override is configured. Preserve this distinction from the Spatial SDK tools root and prove the actual directory layout before passing a value; no environment root was silently changed in the audit. The profiler report changes package metadata and adds `SKIP` / `INSUFFICIENT_DATA`. These require a validated adapter, not just replacing one command token.

The retained run's 0.4.4 `perf --help` exited 1 because utilities 0.1.0 were absent. In 0.5.0, the root perf help rendered, but all five child groups exited 3 because utilities 0.2.0 were absent. The traversal reached everything advertised by the responses it received; **deeper profiler help and behavior remain unproven**. Preserve these failures. No utility setup was attempted.

## Where the MCP should add value

Keep the official CLI responsible for its operations. Make the MCP reliable at selecting context, composing bounded workflows, retaining results and enforcing honest acceptance.

1. **Useful SDK context:** one project-scoped toolchain selection and matching declaration identity throughout preflight, generation, bundling, knowledge and lint. No stale singleton cache after switching roots or replacing an SDK.
2. **Evidence the CLI does not establish by itself:** exact installed APK, boot/process continuity, immutable capture bytes, capture provenance and human/model LOOK. External APK verification needs its own observation identity; it must not invent a fleet build receipt.
3. **Reliable agent transport:** one inner full-surface server under simultaneous first calls, complete structured/error/image/resource forwarding, and recoverable initialization failure.
4. **Honest long-running observations:** requested versus observed duration, end reason, partial coverage, bounded retained logs and known truncation. Report missing measurements as missing.
5. **A release that actually runs the edited source:** source/output identity, fresh test imports, complete CI suite inventory, deterministic smoke/docs gates and immutable distributable artifacts.

Measure cold/warm startup latency, concurrent inner-process count and response bytes with fixed inputs before and after changes. The acceptance target is removal of the demonstrated duplicate initialization/lost-result defects and no unexplained regression; this audit invents no percentage speedup.

## Prioritized delivery

| Priority | Deliverable | Why it belongs in the next checkpoint |
|---|---|---|
| P0 | Current-source testing/build identity and truthful gate inventory | A compatibility fix is worthless if tests and hosts execute stale output. |
| P0 | CLI 0.5 operation contracts: knowledge, perf, crash timing; retained capability evidence | There are concrete command/flag/report changes and existing misleading success paths. |
| P0 | Project-scoped SDK resolution and version-matched knowledge authority | Current doctor disagrees with itself; installed 6.1 must not be confused with old declarations. |
| P1 | Doors single-flight, typed forwarding, external APK observation and artifact validation | These make the MCP a stronger workflow and verification layer. |
| P1 | Complete release reliability: hermetic smoke, deterministic docs, all suites scheduled, immutable package verification | Supports repeatable delivery beyond this host. |
| P2, bounded | Discovery/routing for new CLI areas and capability-status documentation | A useful addition without speculative wrappers. Deeper execution features need their own concrete acceptance criteria. |

Complete P0 and P1 as independent reviewed commits; use a durable checkpoint if external utility provisioning or native acceptance is unavailable. Host implementation can be complete while native validation remains explicitly open. Do not declare full end-to-end compatibility from fixture tests alone.

## Detailed audit sources

- [CLI package delta](../evidence/2026-09-15-cli050-sdk61-evolution-audit-001/CLI050_STATIC_PACKAGE_AUDIT.md): exact published member/line references; source findings are not runtime proof.
- [SDK/toolchain/knowledge audit](../evidence/2026-09-15-cli050-sdk61-evolution-audit-001/SDK61_KNOWLEDGE_AND_TOOLCHAIN_AUDIT.md): resolver contract, cache keys, project context, platform limitations and authority rules.
- [MCP value/reliability audit](../evidence/2026-09-15-cli050-sdk61-evolution-audit-001/MCP_VALUE_AND_RELIABILITY_AUDIT.md): external APK evidence gap, inner-server race, typed-result loss, crash coverage and capture validation.
- [Release/gate audit](../evidence/2026-09-15-cli050-sdk61-evolution-audit-001/RELEASE_AND_GATE_AUDIT.md): source-output freshness, CI omission, smoke, packaging, docs and metadata.
- [Remaining CLI consumer audit](../evidence/2026-09-15-cli050-sdk61-evolution-audit-001/FINAL_CONSUMER_COVERAGE_AUDIT.md): trace load/query contracts and structured emulator status; distinguishes current consumers from prospective integration.

These are a scoped source audit, not a security audit or proof that every MCP feature works. Notable findings include a global logcat clear and potential foreign foreground-app stop in ordinary external-APK verification; tests currently encode that behavior and must change with the implementation.

Do not run `scripts/probe-windows-emulator.mjs` unchanged: it performs a global CLI install before its observations and continues after command failures. Convert it to consume a validated exact CLI path with a failure-aware receipt, or leave it unused. The device-list JSON array-to-object change is documented for future integrations; the audit found no current production parser requiring that conversion.

The CI inventory at this source revision contains 48 `test:` scripts. Workflows schedule 48 total invocations when smoke is included, leaving `test:runrevision` unscheduled; test assertions still use older counts. Fix inventory by derivation and explicit platform classification, not by changing numbers until one snapshot becomes green. A static scan finds 60 of 80 top-level test `.mjs` files import `dist`, superseding the historical count in AGENTS without changing its build-first requirement.

## Execution and acceptance boundaries

The [master plan](superpowers/plans/2026-09-15-cli050-sdk61-evolution.md) sequences three independent implementation tracks and their shared interfaces. It includes CLI/evidence work and links separate SDK and release plans. Use existing tool names and typed schemas when they can be extended safely; document any intentional compatibility change and choose the release version accordingly. Do not promise a version number before that decision.

Required evidence for the new implementation checkpoint:

- Exact source and build identity; base/target CLI package identities and retained help/status evidence, including partial discovery.
- Meaningful regression results against newly built source, including `test:runrevision`, CLI policy/adapter suites, knowledge lifecycle and receipt/ledger guards.
- Fixture coverage for unavailable tools, unsupported flags, invalid reports/media, wrong targets, partial windows, stale caches and concurrent startup.
- Reconciled metadata and CI inventory, reproducible artifact verification from a fresh output directory, and no deletion of prior tarballs.
- A capability matrix labeling source-inspected, help-observed, fixture-tested, host-executed and native/visual-accepted separately.
- Any genuine native block recorded with the exact evidence and remaining acceptance, while independent host work is completed.

Do not rerun the old Mission Replay test battery for this MCP task. Do not run native suites simply because they have a `test:` prefix; inspect their effects and platform requirements first. Off-platform skip is not native validation. If a later native operation is needed, read the relevant local project/emulator instructions and honor their exact visibility, timing, health and retry limits.

## Mission Replay bookmark

The pause is recorded in `/Users/sushantsrikrish/AndroidStudioProjects/rocketsim-mission-replay/docs/MISSION_REPLAY_PAUSED_2026-09-15.md`, pause commit `59f72794`. App source068 is `231dbce3d28ca754109c97baf35d0e8ca1dc80fc`; evidence checkpoint is `ba2b3b4b710cea19c41e7ec708c01190f8c6201f`. Its project BOM remains 6.0.0. Recovery/docking motion review and visitor-control acceptance are not completed by this MCP audit. Resume that app only when the user asks.
