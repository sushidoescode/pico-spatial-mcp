# Fresh-chat prompt: implement the PICO-MCP CLI 0.5 / SDK 6.1 evolution

Copy the following prompt into a fresh chat:

```text
Continue the PICO-MCP CLI/SDK evolution work. This is an implementation task: complete the audited fixes, appropriate tests and release-quality local checkpoint, rather than stopping after another plan. Mission Replay / SpaceX application development remains paused.

Work in:
/Users/sushantsrikrish/PICO-MCP

Start with read-only pico_doctor {}. Read and follow:
1. AGENTS.md
2. docs/CLI_050_SDK61_EVOLUTION_HANDOFF_2026-09-15.md
3. docs/superpowers/plans/2026-09-15-cli050-sdk61-evolution.md
4. docs/superpowers/plans/2026-09-15-mcp-release-reliability.md
5. docs/superpowers/plans/2026-09-15-sdk61-toolchain-knowledge.md
6. evidence/2026-09-15-cli050-sdk61-evolution-audit-001/CLI050_STATIC_PACKAGE_AUDIT.md
7. The three other detailed audits linked by the handoff and the evidence README/index.

Inspect actual HEAD, branch, working-tree changes and built output before editing. The audited source baseline is 308c898e9c33975b5a21ecb78fed245fab17a0ed on main, MCP version 37.0.0. Later checkpoint commits contain this audit/planning evidence, not implemented fixes. Preserve all existing source work and artifacts. Use an isolated feature branch/worktree when appropriate; never discard uncommitted work.

Verified audit facts:
- npm registry latest was CLI 0.5.0 at 2026-09-15T09:03:54Z, published 2026-09-10. Integrity-checked 0.4.4/0.5.0 archives and raw help are retained. Recheck registry freshness only when needed for the new implementation; do not treat0.5.0 as a permanent pin.
- The MCP's cached CLI was still 0.4.4; host SDK 6.1 and spatialbundle 6.1.0.0-rls.25 were installed. Legacy preflight still reported sdk/0.13. Host SDK, project BOM and declaration revision must be resolved separately.
- Canonical knowledge startup is now knowledge server. Our default still uses mcp dev-knowledge; published 0.5 source retains colon aliases, not that spaced default.
- watch-crash now exposes --monitor-timeout. Our wrapper has obsolete timing claims and can report requested duration after an early exit.
- The perf adapter uses perf monitor run and old flags/report assumptions. The published 0.2 profiler uses live run; establish exact arguments, save behavior, PICO_HOME requirements and schema from retained sources and provisioned help before runtime use.
- Help traversal reached 69→91 paths, including groups, with 25 additions and 3 removals. Five 0.5 profiler child help calls failed because utilities 0.2.0 were absent. This is partial discovery, not full compatibility. Preserve those failures; no utility setup was run.
- Official 0.5 includes new knowledge, SpatialML, project-context and Editor workflow capabilities. Strengthen our orchestration, provenance and verification; avoid duplicating an official controller or adding a thin MCP tool for every CLI command.
- Audit source findings include stale dist/test/bootstrap behavior, omitted runrevision CI coverage, nondeterministic smoke/docs checks, artifact-overwriting publication, doors concurrent-initialization/typed-result loss, and weak external-APK/media verification. Detailed reports and acceptance tests are in the plan.

Execute autonomously in reviewed increments:
1. Establish current-source build/test identity and correct suite inventory first.
2. Implement canonical CLI operation/capability contracts, knowledge transport, truthful watcher coverage and the perf adapter.
3. Implement project-scoped SDK/toolchain selection, cache invalidation and version-matched knowledge authority, preserving existing application BOMs and historical declaration mappings.
4. Complete doors single-flight/typed forwarding, immutable external-APK observation and real media validation without weakening receipt/ledger guards.
5. Finish release reliability and bounded discovery/routing documentation. Reconcile version, lockfile and host manifests only when final scope justifies the version decision.

Use applicable skills and parallel agents for independent host work. Assign one owner to shared source files. Build before tests importing dist; do not rerun unrelated completed app tests. Keep negative evidence and use fresh output paths. Read-only/fixture/host/source-derived/native/visual evidence must be labeled separately.

Constraints persist:
- Never restart or move/resize the emulator, kill unrelated processes, change Wing, push, or rewrite history.
- Root alone owns emulator-5554. Native work requires all existing visibility, timing, numeric health and retry gates; an SDK update or fresh chat does not reset holds or thresholds.
- The audit found stale calibration after the latest emulator boot. That does not block independent host implementation. Do not calibrate or manipulate the emulator just to make this task's doctor green.
- Preserve the exact AGENTS managed-CLI contract. No incidental global CLI/PATH changes, automatic utility setup or host-plugin reconfiguration. Activation of an exact CLI package and utility provisioning are separate actions. Missing optional utilities must not prevent all useful host work.
- No emulator account sign-in or copying Chrome credentials. If an optional official service really needs authentication, record its exact scope/error and continue independent work.
- Do not edit, build, deploy or migrate /Users/sushantsrikrish/AndroidStudioProjects/rocketsim-mission-replay. Its pause remains active; its previous app evidence is not SDK 6.1 acceptance.
- Preserve original evidence bytes, explicit serial/APK/boot/process identity, safe child ownership, typed results and the LOOK requirement. No global logcat clear or foreign-app stop in ordinary verification.

Deliver the implemented local source checkpoint, newly built-source test results, a verified distributable only when its required gates pass, updated capability matrix, and a concise continuation note for any genuinely unavailable native/utility acceptance. Do not claim full end-to-end or cross-platform compatibility from help/fixtures, and do not claim Mission Replay or the full app is finished. No push.
```

The [handoff](CLI_050_SDK61_EVOLUTION_HANDOFF_2026-09-15.md) is the specification; the [master plan](superpowers/plans/2026-09-15-cli050-sdk61-evolution.md) supplies ordered tasks and links the two independent implementation tracks.
