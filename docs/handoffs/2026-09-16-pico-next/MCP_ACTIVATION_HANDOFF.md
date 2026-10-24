# MCP activation and native acceptance handoff

## Objective

Continue from accepted f349eaf, establish that the intended local MCP and CLI execute in real hosts, and earn bounded SDK 6.1 build/render/interaction evidence on the user's physical headset and, when admitted, the emulator. Complete useful independent lanes even if a manual setup, unavailable OS or host reload remains blocked. Do not expand this into another unrestricted repository cleanup.

Read [the identity and observations](README.md) first. This handoff is the execution specification for [Chat A's prompt](CLAUDE_MCP_ACTIVATION_PROMPT.md).

## Required local context

In the accepted worktree read, in order:

1. AGENTS.md and .claude/CLAUDE.md; relevant .claude/rules files.
2. docs/findings/CLI050_HOST_COMPLETION_CHECKPOINT.md.
3. docs/findings/CLI050_CAPABILITY_MATRIX.md.
4. docs/HOSTS.md and the exact host manifests/bootstrap implementation you will use.
5. The historical implementation checkpoint only for unresolved provenance or incident details.

Do not copy stale directions: docs/HOSTS.md contains old bootstrap wording; the implementation now checks receipts. A GitHub marketplace installation cannot fetch unpublished local commits. Confirm the actual local source/archive selected by each host.

For emulator work only, read the current /Users/sushantsrikrish/AndroidStudioProjects/rocketsim-mission-replay/AGENTS.md health/input rules and docs/MISSION_REPLAY_PAUSED_2026-09-15.md as governing preserved constraints. This is read-only context, not permission to open its project in an editor, build, launch, migrate, install or modify it.

## Autonomy and allowed actions

When the user pastes the companion prompt, it authorizes:

- Isolated local worktrees/branches, focused fixes, appropriate tests/builds and coherent reviewed local commits.
- Reversible activation of the candidate in installed local hosts, with exact configuration backups and a rollback recipe.
- Local integration into main after the applicable evidence gates pass, preserving history.
- Creation, build, installation, launch, scoped logging, capture and performance testing of dedicated acceptance/showcase packages on the explicitly identified owned headset.
- Emulator tests only after the preserved admission gate, with root as sole operator.

Do not push, publish remotely, rewrite history, remove old worktrees/artifacts, change Wing, restart/move/resize the emulator, kill unrelated processes, alter global CLI/PATH, clear global log buffers, or change unrelated apps. Preserve the paused app. Do not factory-reset, change headset firmware, disable guardian/boundaries or alter safety settings. Keep capture aimed at the test app; do not collect unrelated private content.

Manual utility setup, account authentication and device pairing/USB confirmation remain user actions when required. Provide the exact supported command/action and why it is necessary; never request passwords, copy browser sessions or assume emulator sign-in is required. Continue independent work while waiting.

## A1 — prove identity and prepare isolated acceptance work

- Start with read-only pico_doctor {}. Identify which server executed it; it may be the old main checkout. Save fresh evidence without overwriting prior output.
- Inspect git HEAD/status/ancestry, archive digest and build receipt. Reconcile changes since f349eaf instead of resetting them.
- Use a fresh branch/worktree descended from accepted f349eaf, for example cli050-native-acceptance-2026-09-16, choosing a fresh suffix if occupied. Preserve the accepted branch.
- Inventory active host registrations without exposing tokens. Back up exact files before edits. Avoid duplicate registrations or silently replacing other servers.
- Choose a fresh evidence root, such as evidence/2026-09-16-mcp-native-acceptance-001; reserve a new number if it exists.
- Reuse the retained host battery unless changed inputs, environment or a discrepancy justify rerunning it. No native actions from fixture tests: use the enforced runner; direct tests must explicitly pin nonexistent ADB before any RED run. Build before tests that import dist.

Deliverable: identity.json plus a short ledger of observed active and candidate identities, plan phases and exclusions.

## A2 — activate the candidate and establish real host discovery

Start with the current Claude host. Use the local candidate plugin/source path or verified archive; back up existing configuration. Read host-specific current help/docs before editing registration.

For each installed/available Claude Code, Codex and Cursor host retain: host name/version, registration route, plugin/source identity, expanded launch command, actual server entrypoint/version, startup result, actual tools/list, and a benign real request/response. Prefer the 18-door surface. Full-surface use must be explicit and scoped.

A stdio probe proves MCP transport, not host-plugin discovery. A manifest scan proves neither. If a host needs a user reload, give exact instructions once and complete other work; do not claim the still-running host has reloaded itself. Do not kill another host to force discovery.

Use a candidate child stdio process if necessary for independent acceptance while reload is pending, clearly labeling it as direct transport. Avoid sending native operations through the old connected server by mistake.

Deliverable: per-host discovery receipts; available, failed and unavailable hosts identified separately.

## A3 — resolve CLI, SDK and profiler capability

Follow the canonical policy block in AGENTS.md without modifying it. Run the candidate's supported ensure_pico_cli health path to establish the exact CLI package/version/path/freshness; preserve ambient installations. CLI 0.5 is the intended capability line, not a timeless latest-version assertion. If the registry now selects a newer version, record that fact and establish compatibility before relying on changed commands.

Read the selected CLI's actual help. When it reports a missing utility payload, return its absolute executable plus the required setup arguments for the user to run. Do not execute setup automatically. Once the user completes it, retain exit-zero help for the selected perf/trace routes and test their semantics on the named demo target.

Record SDK tool selections separately for packer/editor/emulator and the demo's Gradle/BOM/dependency resolution. Use current local declarations or authoritative vault file/line citations. Public 6.1.9 docs are leads, not permission to substitute dependency versions.

Fix only blocking findings in this lane. Two carried source-review follow-ups deserve targeted treatment:
- check_toolchain_updates wording can call an advertised 6.x payload “newer” without comparing installed revisions.
- assert_logcat can see a marker once, then suffer persistent dump failures and report an ordinary miss. Before relying on automated replan/retry logic, cover this transition with a fixture and report missing observation as inconclusive. Alternatively keep automated replanning disabled for this acceptance run.

If source/package bytes change, produce a new version and fresh archive/receipt under repository release rules. Never replace one of the three retained 38.0.0 archives. Record why each test rerun is needed.

Deliverable: exact CLI/SDK/profiler capability receipt, plus reviewed focused fixes when needed.

## A4 — device routing and a dedicated acceptance app

Identify the connected physical headset read-only. Record actual model/product, explicit serial, runtime/build, authorized connection and supported ABI. Select the user's single unambiguous headset; ask only if multiple candidates or an authorization dialog make identity uncertain. The marketing name “Space Pro” is not a serial or capability proof.

Create a separate project, proposed path /Users/sushantsrikrish/AndroidStudioProjects/pico-ui-polish-lab and applicationId dev.local.picouipolish.lab. If either exists, inspect and preserve it, selecting a new isolated path/package when unrelated. Chat B will reuse this project if created here. Its initial screen needs native text, one real button/state change and one window/container, not a broad product.

Build from resolved SDK 6.1 declarations. Match APK native ABIs to the actual target; do not assume an emulator APK runs on the headset. Record source identity and separate APK hashes when target variants differ.

Critical routing constraints at f349eaf:
- fleet_build hardcodes emulator-5554 and exposes no serial. pico_build_app/pico_loop build through it. Do not use these for physical acceptance unless explicit targeting is first implemented and proved.
- pico_look has no serial input. It is not a physical-headset capture route.
- Prefer verified full-surface build_and_run with explicit serial, verify_pico_apk with required serial, and explicitly targeted capture operations with unique output paths. Inspect these tools' current schemas and all nested calls first.
- Pass device explicitly to every perf route. Do not depend on defaults.
- A validated CLI/ADB route with explicit serial is acceptable when the MCP cannot represent the operation; retain that provenance and do not claim the MCP routed it.

Install/launch only this new package and owned test packages. Prove the installed package/build, process and captured frame correspond to that target. Do not clear buffers; use bounded correlated observation. Open every claimed frame. Exercise the real button and show the resulting state; a debug state injection alone is not interaction acceptance.

Deliverable: build/install/launch/interaction evidence manifest with serial, package, APK digest, installed identity, PID/boot context, command exit codes, fresh frame paths/hashes, and observations.

## A5 — emulator admission, if this lane is used

Do not restart the emulator or move/resize its host window. Root alone operates it. Stale calibration is a separate prerequisite for calibrated placement and dependent tools; it does not make an old frame acceptable. If calibration must launch an owned test app, first establish that the existing gate can be satisfied without bypassing it. Use the supported calibration workflow only within these constraints; otherwise retain the blocker and continue physical/host work.

Read and use the preserved package-targeted render-liveness/1.0.0 tooling. Locate its exact existing path under the paused repository read-only; a copied helper must retain source hash/provenance and must target the new demo package. Do not substitute a weakened gate.

Before every emulator capture, watch, performance run or LOOK:
- Fresh unfiltered 20-second main-buffer sample.
- Host emulator frontmost and unoccluded before sampling, after sampling and after any capture.
- Clean timed window; zero “last_known_vsync_start is early more than 1S”.
- Average PxrMetric FPS >=50 as a secondary check; this is not application FPS.
- At least 18 watchdog samples, all naming the target package.
- Monotonic lastRenderTime advancement >=18000 ms; zero consecutive non-advancing samples.
- Every age currentTime-lastRenderTime is 0..100 ms, including rejection of negative ages.
- One watchdog emitter; no malformed samples, duplicate/non-increasing checkCount, out-of-order timestamps or clock reset.
- Installed build SHA-256 and PID unchanged throughout.
- Preserve SPR observations without restoring the superseded SPR threshold.

Occlusion permits AXRaise/frontmost restoration, ten seconds settling and a complete fresh gate whenever it recurs. It does not consume a numeric retry. Persistent numeric failure while truly visible permits one fresh retry after diagnosis; if that also fails, retain both failures and hold emulator work. No retry reset because of a new chat. No locked-screen visual/performance claims.

For emulator input, derive coordinates from a 3x crop of a retained frame and hover-verify the first target with the existing package-targeted input helper; retain cursor evidence. This is separate from headset interaction.

These emulator thresholds do not establish physical-headset health or replace measurement against the physical target's actual refresh rate.

Deliverable: fresh admission/visibility receipts and opened captures, or a precise hold. Build065's historical hold must not be presented as the current hold.

## A6 — complete available acceptance lanes and integrate locally

- Exercise provisioned profiler help and a bounded sample on the explicit demo target. Report supported/missing counters and native execution separately.
- Run real Linux/Windows tools/list only on genuinely available OS hosts/runners. Do not install VMs or remote infrastructure merely to green the table. Fixture emulation on macOS remains fixture evidence.
- Review focused changes and run their appropriate gates. Run the full host battery once on the final changed release candidate when source/package changes warrant it; do not repeat an unchanged battery.
- Before integration verify current main ancestry and cleanliness again. Fast-forward locally when possible. If main advanced, use normal history-preserving integration in isolation with conflict review and relevant checks; never reset or force it.
- Native appearance/perf gaps remain named even if host-accepted code is integrated. Block activation/integration if observed behavior risks wrong-device mutation or evidence destruction.
- Preserve configuration rollback, old archive, accepted worktree and evidence. If active registrations referenced a worktree, retain it.

Deliverable: local integration/activation checkpoint naming exact commits and installed artifact identity, host results, native results and unresolved lanes. A green fixture suite is not whole-system acceptance.

## Completion boundary and next chat

Chat A is complete when available lanes have earned their evidence, focused blockers are resolved, and truly external limits have a concrete next action. A user setup/reload/comfort task may remain pending; no silent pass. Do not continue broad cleanup to consume time.

Create docs/findings/CLI050_NATIVE_ACCEPTANCE_CHECKPOINT.md in the continuation branch, including:
- integration and active-server status;
- exact source/package/CLI/SDK/device identities;
- per-host discovery and per-target acceptance table;
- artifact inventory and rollback;
- logs/captures reviewed, failures preserved;
- available/unavailable perf and OS checks;
- emulator hold or admission status;
- safe demo project/package for Chat B;
- a short next prompt.

Use only earned repository evidence classes when recording claims. Reserve physical-device verification for actual physical evidence; in-headset comfort/depth observations require the wearer. Mission Replay remains paused.

