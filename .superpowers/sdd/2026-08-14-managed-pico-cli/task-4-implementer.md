# Task 4 implementer report — managed CLI consumers

Date: 2026-08-14

## Revision and scope

- Requested base: `65002af8a0a4394c915785f74ebc88e16487cf18`
- Verified starting `HEAD`: `65002af8a0a4394c915785f74ebc88e16487cf18`
- Verified merge-base with the requested base: `65002af8a0a4394c915785f74ebc88e16487cf18`
- Result head: the Task 4 commit containing this report (`git rev-parse HEAD` is reported in the parent handoff; a commit cannot embed its own content-addressed hash).
- Worktree: `/Users/sushantsrikrish/PICO-MCP/.worktrees/pico-evolution-2026-08-14`
- No push, remote mutation, permission change, or visibility change was performed.

Task 4 changed only the eight listed production consumers, the five listed test files, and the scout-authorized existing managed fixture helper/fake knowledge fixture. No Task 5+ production work was included.

## TDD evidence

Observable tests were added before production changes and run RED against the ambient/global implementation.

- `npm run build` — PASS on the untouched production baseline.
- `node test/picocli.mjs` — intended RED, 3 failures: the two setup-gate cases still classified as `not-provisioned`, and the absent preflight row did not describe lazy managed provisioning.
- `node --test --test-name-pattern="Task 4 production adapters" test/picocli-autoinstall.mjs` — intended RED: startup/tools-list remained non-provisioning, while four managed-consumer assertions failed for missing managed absolute-path/provenance behavior, missing `setup-required` manual guidance, legacy-controlled rather than forced health refresh, and non-option/strength-aware coalescing.
- `node test/preflight.mjs` — intended RED, 2 failures: empty production preflight lacked the managed-first-use warning and cached preflight did not use the managed absolute shim/status path.
- `node test/doors.mjs` — intended RED, 2 failures: doctor lacked the managed-first-use warning and the old PATH mutation caused an inner-server recycle.
- `node --test --test-name-pattern="KnowledgeBridge" test/distribution-adoption.mjs` — intended RED: the production bridge tried ambient `pico-cli` and failed with `spawn pico-cli ENOENT` instead of starting `mcp dev-knowledge` from the managed absolute shim.

The final GREEN suite also preserves equivalent isolated coverage for behavior formerly exercised by ambient global-install tests: Windows `.CMD` candidate construction and provisioning classifiers are pure tests; managed resolver tests cover bounded npm timeout/tree settlement, exact installs/updates, failure/fallback/corruption, immutable publication, and concurrency; fresh-child MCP tests cover wrapper provisioning, unavailable resolution, runtime setup refusal, artifact failure provenance, health refresh, and coalescing.

## Implementation

### Managed adapter and contract

- `src/picocli.ts` now re-exports the managed package/policy/path authorities and managed result/options types.
- Production managed IO is constructed once with the process environment, platform, captured home, UUID source, and the existing bounded command runner.
- `ensurePicoCli()` delegates to `resolveManagedPicoCli()` and `inspectPicoCliCached()` delegates to the read-only managed inspector.
- In-process coalescing keys the resolved managed root plus timeouts/grace. Weak calls share active weak/strong work; a forced refresh arriving behind weak work runs afterward; weak callers share an active forced refresh; different option keys remain independent.
- Deprecated `explicit`/`update` call inputs and auto-install/auto-update export names remain compatibility-only and inert. No production consumer reads them.
- Global-prefix exposure, global `npm install -g`, registry `update --check`, and PATH mutation were removed. The bounded runner, output cap, process-tree timeout behavior, semver comparison, envelope parsing, and failure classifiers remain.
- Successful managed results convert only to their absolute resolved path and expose `picoCli` provenance (`source`, `policy`, `path`, `version`, `latestVersion`, `checkedAt`, `freshness`, `action`, optional warning).
- Wrapper schemas now expose provenance and structured absolute `setupCommand`; observable `not-provisioned` became `setup-required`.

### Consumers

- `ensure_pico_cli` always calls `ensurePicoCli({forceRefresh:true})`; deprecated `{update:true|false}` is accepted but does not control freshness.
- Perf diagnose, trace, crash watch, and capture record run the resolved absolute shim. Every result after a successful ensure carries provenance, including runtime/setup/report/artifact failures.
- Setup refusal returns `{path: <absolute managed shim>, args:["setup"]}` and is never executed.
- Production preflight and default doctor inspect only the cached managed store. Empty cache is a warning that first CLI use will provision; a valid cache may run its absolute `-v` validation and `emulator status`, without registry/install calls.
- Production knowledge resolves before every call, starts `mcp dev-knowledge` by absolute path, keys a child on actual path/version, retires before starting a changed version, and retires an active child if resolution becomes unavailable. A custom injected command bypasses managed resolution unchanged.
- Doors no longer tracks inherited PATH or recycles its inner server after managed ensure.

## Files changed

Production:

- `src/picocli.ts`
- `src/picoclihealth.ts`
- `src/preflight.ts`
- `src/knowledge.ts`
- `src/perfcli.ts`
- `src/perftrace.ts`
- `src/picoclitools.ts`
- `src/doors.ts`

Tests/authorized fixtures:

- `test/picocli.mjs`
- `test/picocli-autoinstall.mjs`
- `test/preflight.mjs`
- `test/doors.mjs`
- `test/distribution-adoption.mjs`
- `test/helpers/picocli-managed-fixture.mjs`
- `test/fixtures/fake-knowledge-server.mjs`

## Final verification

Before the final gate sequence:

```text
SENTINEL PASS: /Users/sushantsrikrish/.pico-mcp/cli absent
```

Exact Task 4 gates:

- `npm run build` — PASS (`tsc`, exit 0).
- `npm run test:picocli` — PASS (pure lane reports `Failures: 0`; the complete managed TAP suite exits 0, including the 6 Task 4 adapter subtests).
- `npm run test:preflight` — PASS (`Failures: 0`, including empty/cached fresh-child managed-store checks).
- `npm run test:doors` — PASS (`Failures: 0`, including default doctor read-only behavior and one inner lifetime across ensure).
- `npm run test:briefroute` — PASS (`briefroute: all assertions passed`).
- `node --test --test-name-pattern="KnowledgeBridge" test/distribution-adoption.mjs` — PASS (`9/9`, 0 failed).
- `git diff --check` — PASS, no output.

After the full gate sequence:

```text
SENTINEL PASS: /Users/sushantsrikrish/.pico-mcp/cli absent after gates
```

Contract-truth searches found no server consumer of legacy policy aliases, no production global install/prefix/update-check/PATH mutation, and no wrapper/health/knowledge production path using the retained ambient compatibility probes. The changed-file list matches Task 4 plus the two scout-authorized fixtures.

## Safety incident and recovery

During an early post-implementation full `node --test test/picocli-autoinstall.mjs` run, an obsolete pre-Task-4 ambient test called the new default `ensurePicoCli()` in the parent test process after that module had captured the real home. The test's fake npm/CLI—not the real registry or global CLI—published fixture version `0.3.0` under `/Users/sushantsrikrish/.pico-mcp/cli`, with fixture integrity `sha512-fixture` and a shim targeting the temporary `fake-command.mjs`.

The run was stopped. The exact fixture-owned `versions/0.3.0` and `.0.3.0.publish` entries were inspected, moved recoverably to `/tmp/pico-task4-real-home-quarantine.W5mCuK`, and the now-empty real-home CLI directories were removed with `rmdir`. The parent independently confirmed that the real managed root was absent and that quarantine contained only the fixture `0.3.0` data with the publication hard link preserved. Per instruction, quarantine has not been modified since recovery and remains intentionally available for inspection/recovery. The obsolete ambient test block was replaced by isolated managed tests, and the real-root absence sentinels passed before and after the final gates.

No real npm registry, global CLI, `pico-cli setup`, `pico-cli update --check`, emulator/device, Swan, or Windows machine was touched. All CLI/npm/knowledge commands in behavior tests were fake commands under temporary roots; production-adapter tests used fresh child processes with isolated `HOME`/`USERPROFILE` and managed roots.

## Assumptions and limits

- Retained PATH probe exports are compatibility utilities only. Production wrappers, health, bounded preflight, and default knowledge do not call them.
- `defaultIO()` remains the synchronous injected preflight evaluator seam; registered production preflight uses the read-only bounded managed adapter.
- The mandated KnowledgeBridge pattern gate was run, not the entire distribution-adoption suite.
- Windows-specific candidate/classifier behavior is fixture-tested only; no Windows environment was exercised.
- No visual result was produced or claimed, so rendered-frame verification does not apply.
- The external quarantine is deliberately not part of the git change and must not be deleted without separate user direction.
