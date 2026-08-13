# 2026-08-12 Audit Remediation Plan

**Goal:** Repair the independent audit's trust, test-runner, documentation, and `pico_loop` findings without creating any new unmeasured claim.

**Evidence boundary:** Code and host-side tests can establish structural behavior only. No Swan hardware or native Windows host is available in this session. Visual verification remains limited to the two frames already inspected by the independent audit.

## Design decisions

- Visual ledger writes copy the validated capture into `~/.pico-mcp/ledgers/artifacts/<sha256>.<ext>` before appending the entry. The ledger records that immutable path and retains the supplied path only as source provenance.
- Ledger reads validate the stored image again and compare its hash, dimensions, byte count, and format with the recorded capture metadata. Missing, malformed, or mismatched artifacts are reported as `provenance-broken`; they never enter a visual-evidence bucket.
- Retractions are append-only events that target an earlier sequence number. Reports retain complete history while excluding the retracted claim from active evidence.
- The battery implementation is tracked under `scripts/`; the ignored `.dev/run-battery.mjs` entry point delegates to it. Every invocation runs, and the process exits only after printing an aggregate summary.
- `pico_loop` evaluates launch log evidence before any structural probe can clear logcat, reports actual spec mutation independently of `recompileSubtree`, and stops with an actionable manual-repair result when a failure class has no safe automatic mutation.
- Published measurements name their method and evidence boundary: `tiktoken`/`o200k_base` over `JSON.stringify(result.tools)` returned by `tools/list`, not total host context.

## Ordered tasks

- [x] P0-1: Write failing ledger tests for immutable copies, source overwrite resistance, read-time hash downgrade, missing artifacts, and append-only retraction.
- [x] P0-1: Implement the content store, report-time provenance gate, and retraction event model; run `npm run build && npm run test:ledger`.
- [x] P0-1: Append the requested `com.fleet.door448144` retraction through the tested implementation, without changing the original entry.
- [x] P0-2: Write a failing test for a keep-going battery executor and aggregate exit status; implement it and delegate the ignored `.dev` entry point.
- [x] P0-2/P0-3: Correct the six unearned battery claims and replace the false recenter implementation with the real gRPC command; gate both corrections.
- [x] P1 docs: Correct the pico-cli 0.4.2 delta inventory, update-cache side effect, token measurements, tool-count provenance, answer count, and ignored-file citations.
- [x] P1 loop: Add deterministic injected-call tests for mixed criteria, genuine spec mutation with an empty compile subtree, non-repairable failures, visual escalation classes, and structured outputs.
- [x] P1 loop: Implement the smallest behavior changes that satisfy those tests and document the remaining automation ceiling honestly. Generic low-FPS failures remain measured but manual because no safe automatic quality tradeoff exists.
- [x] P2: Remove only the audited uncommitted workbench-wave paths from the original worktree, preserve its rejected plan with the architectural verdict, and verify no unrelated dirt was removed.
- [ ] Run the complete battery, the four CI job commands, `git diff --check`, metadata/documentation gates, and an independent code review. Commit with the exact commands and outcomes; do not push.
