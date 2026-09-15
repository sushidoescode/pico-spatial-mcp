# CLI 0.5.0 and SDK 6.1 MCP Evolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a current-CLI-compatible MCP whose SDK context, observations and release artifacts are dependable and whose orchestration adds value to the official tools.

**Architecture:** Keep official CLI operations behind the existing managed execution boundary. Resolve operation capabilities and project identity explicitly, then preserve typed results and immutable evidence through the doors surface. Implement release reliability and SDK provenance as separately reviewable tracks; avoid rebuilding official Editor or SpatialML controllers.

**Tech Stack:** Node.js >=20, TypeScript, MCP SDK, Zod, Node test runner, official PICO CLI, installed PICO Spatial toolchain.

**Spec:** [Evolution handoff](../../CLI_050_SDK61_EVOLUTION_HANDOFF_2026-09-15.md), including its linked source audits and retained CLI help.

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

## Sequence and ownership

1. Establish the actual source/environment baseline, then complete the source freshness and suite-inventory tasks in the [release reliability plan](2026-09-15-mcp-release-reliability.md). This makes subsequent regression results meaningful.
2. Execute C1–C4 below for current CLI contracts. In parallel, execute the [SDK/toolchain/knowledge plan](2026-09-15-sdk61-toolchain-knowledge.md), with a single owner for shared knowledge/doors files.
3. Execute C5–C7 below and finish the release reliability plan. Keep each deliverable in a small, reviewed local commit; no push.
4. Reconcile all interfaces, run the necessary final checks against current built source, then write a new implementation checkpoint and capability matrix. Native and utility-dependent gaps remain explicit if unavailable.

The source baseline is `308c898e9c33975b5a21ecb78fed245fab17a0ed`, version `37.0.0`. Resolve any later changes before applying this plan. Do not re-run already completed Mission Replay tests. Read the audit's raw help before performing another sweep; repeat only for changed inputs or to fill a documented evidence gap.

## File map

| Responsibility | Existing files | Proposed focused additions |
|---|---|---|
| Managed CLI execution/probes | `src/picocli.ts`, `src/picoclimanaged.ts` | `src/clicapabilities.ts` |
| Knowledge transport | `src/knowledge.ts` | Extend existing lifecycle fixtures |
| Perf/trace and watch/record wrappers | `src/perfcli.ts`, `src/perftrace.ts`, `src/picoclitools.ts` | `src/cliobservations.ts`, `test/cliobservations.mjs` |
| Help comparison | `scripts/compare-picocli-surfaces.mjs`, `.github/workflows/picocli-compat.yml` | Raw-output fixture directories under `test/fixtures/picocli/` |
| Inner MCP connection/results | `src/doors.ts` | `src/innerclient.ts`, `test/innerclient.mjs` |
| External APK/media evidence | `src/verifyapk.ts`, `src/capture.ts`, `src/nativefleetreceipt.ts` | `src/artifactinspection.ts`, `test/artifactinspection.mjs`, `test/verifyapk-observation.mjs` |
| SDK selection/authority | See SDK subplan | Owned by SDK track |
| Build/test/release reliability | See release subplan | Owned by release track |

These names define the planned boundaries, not permission for an unrelated monolith refactor. Reuse existing safe utilities and schemas. If an existing module already provides the needed contract, document the smaller implementation instead of duplicating it.

## C1: Retain capability evidence and classify operations truthfully

**Files:** modify `scripts/compare-picocli-surfaces.mjs`, `.github/workflows/picocli-compat.yml`, `.github/workflows/windows-emulator-probe.yml`, `scripts/probe-windows-emulator.mjs`, `src/preflight.ts`, `src/picoclimanaged.ts`, `src/picocli.ts`; create `src/clicapabilities.ts`; extend `test/picocli-sweep.mjs`, `test/picocli-autoinstall.mjs`, `test/picocli.mjs`, `test/preflight.mjs`; extend `test/windows-emulator-probe.mjs`.

**Interface:** keep package activation and per-operation availability separate. A missing optional profiler must not invalidate an otherwise usable package. A help hash alone must not enable an operation.

```ts
export type CliOperation = "knowledge-server" | "watch-crash" | "capture-record" | "perf-live"
  | "trace-record" | "trace-decode" | "trace-load" | "trace-query";
export type HelpObservation = {
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
  stdoutPath: string;
  stderrPath: string;
  stdoutSha256: string;
  stderrSha256: string;
};
export type OperationCapability = {
  operation: CliOperation;
  state: "supported" | "unavailable" | "unknown";
  argvPrefix: string[] | null;
  reason: string;
  evidence: HelpObservation[];
};
export type CliCapabilityIdentity = {
  version: string;
  executablePath: string;
  packageJsonSha256: string;
  executionTreeSha256: string;
};
export type CliCapabilitySet = {
  schemaVersion: 1;
  identity: CliCapabilityIdentity;
  checkedAt: string;
  operations: OperationCapability[];
};
```

Derive this identity from the existing validated managed execution manifest or equally validated external executable/package identity. Consumers must match the entire identity against their resolved execution target before using any operation record. A path/version string alone is insufficient. `supported` here means supported by the linked discovery evidence, not runtime or visual acceptance.

- [ ] Capture fixtures from this audit for root help, knowledge server, watch timeout, capture duration, profiler unavailable and project-context change. Keep original bytes plus source version/hash. Do not replace historical 0.4.2/0.4.4 fixtures.
- [ ] Add sweep regressions that retain per-invocation argv, status, raw streams, byte limits and completion state on both success and failure. A child returning an error instead of commands must produce partial subtree coverage. Use the six nonzero results in `RAW_HELP_INDEX_002.json` as the real failure cases.
- [ ] Add central guard regression cases; retain the existing setup-subtree and mutating-update exclusions, detached-child ownership constraints and maximum depth/call/time/output limits. Inspect the audit-only retained comparator as a diagnostic example; do not copy it wholesale as production design.
- [ ] Add operation-classification tests for successful matching help, generic parent help, missing utilities, malformed help, timeout and unsupported aliases. Extend failure classification for observed `Unknown perf subcommand`; treat `PICO_HOME is not set` as an environment problem with exact guidance, without assuming that automatically running setup is its fix.
- [ ] Add stale-capability tests for a selected CLI version change, same-version package/execution-byte replacement, external executable replacement and missing evidence bytes. Reject dispatch or request fresh bounded discovery; never apply old capabilities to a newly resolved target.
- [ ] Tighten the emulator-status consumer in `preflight.ts`, coordinating its shared-file edit with the SDK track. Require `tool_name: emulator.status` and consistency between execution result and envelope. Add `SUCCESS`/nonzero, wrong-tool, `PARTIAL`/4, `FAILED`/3, malformed, timeout, spawn-error and integrity-rejection fixtures. Preserve the expected PARTIAL warning and all independent health gates.
- [ ] Replace the Windows probe's global installation with an explicit validated absolute CLI path supplied to its injected runner. Record requested/reported package identity and stop dependent observations if version/integrity checks fail. Add a fixture in `test/windows-emulator-probe.mjs` asserting zero npm/global-install calls, exact executable targeting and failed-version short-circuit. Update the Windows workflow call site to supply the validated path through the normal managed resolution boundary and use a fresh output path; update the existing tests that encode global installation and unconditional continuation. Do not run the real Windows/emulator probe on this host or use an existing ambient executable after a failed install.
- [ ] Implement immutable reports with aggregate `complete`/`partial` state and raw paths. Preserve old report consumers with additive schema fields or a documented versioned reader. Keep startup/default doctor offline and non-provisioning.
- [ ] Update the scheduled comparison to a documented supported baseline and freshly resolved registry target, retaining exact versions and failures as CI artifacts. Do not hardcode 0.5.0 as eternally latest. A scheduled check is not automatic semantic certification or a request to publish.
- [ ] Build, then run `npm run test:picocli`, `npm run test:preflight`, `node --test test/windows-emulator-probe.mjs` and relevant distribution-policy fixtures. Confirm the default doctor/registration tests observe zero registry/install/setup calls. Commit only this deliverable.

**Acceptance:** the previously green-looking help report clearly exposes inaccessible profiler subtrees; per-operation status identifies what can be attempted, while cache integrity and all policy guarantees remain intact.

## C2: Use the canonical knowledge server without losing lifecycle safety

**Files:** modify `src/knowledge.ts`, `src/picoclimanaged.ts`, `src/clicapabilities.ts`; extend `test/knowledge-lifecycle.mjs` and `test/picocli-autoinstall.mjs`.

**Interface:** managed transport selects argv from the C1 capability set only after its identity matches the execution target; explicitly configured external command/args retain their exact existing behavior. The SDK track owns `readDeclarationIdentity` and verified compatibility-record loading. The CLI adapter supplies root/workspace hints only, independently of graph transport availability; hints cannot establish declaration authority.

```js
// Required fixture assertions over the captured spawn argv:
assert.deepEqual(spawnsFor050.map(x => x.args), [["knowledge", "server"]]);
assert.deepEqual(spawnsFor044.map(x => x.args), [["mcp", "dev-knowledge"]]);
assert.equal(unknownCapabilitySpawns.length, 0);
assert.deepEqual(externalSpawn.args, ["custom-server", "--stdio"]);
```

- [ ] Extend the existing fake MCP process fixture to capture argv under exact 0.4.4 and 0.5.0 identities. The published 0.5.0 source retains colon aliases, but the default should use `knowledge server`; do not silently retry arbitrary aliases after a server error.
- [ ] Add tests proving configuration overrides, cold startup, concurrent callers, cancellation, EOF retirement, timeout, output cap, wrong/reused PID and generation ownership still behave as today. These are load-bearing existing protections.
- [ ] Implement canonical dispatch and update the diagnostic canary. Preserve structured error evidence and exact CLI provenance; missing knowledge data and transport startup failure remain distinct.
- [ ] Reconcile graph action/input/output compatibility using the published server declarations and a harmless fixture server. A transport start alone does not establish API shape or matched SDK declarations.
- [ ] Build; run `npm run test:knowledge-lifecycle` and `npm run test:picocli`. Review with the SDK-track owner before committing shared files.

**Acceptance:** current CLI receives its actual canonical command; legacy/external configurations remain intentional; no unrelated process can be killed and no graph result is promoted to exact declaration authority.

## C3: Correct watcher timing and retain observation coverage

**Files:** modify `src/picoclitools.ts`, `src/picocli.ts`; create `src/cliobservations.ts`, `test/cliobservations.mjs`; extend `test/picocli.mjs`.

**Interface:** add honest coverage fields without silently changing the meaning of an existing output. Deprecate misleading `watchedSec` if compatibility requires retaining it; set it only to observed duration with an explicit schema/documentation change.

```ts
export type ObservationCoverage = {
  requestedDurationSec: number;
  elapsedSec: number;
  monitoredSec: number | null;
  endedBy: "cli-exit" | "native-duration" | "watchdog" | "error";
  coverage: "complete" | "partial" | "unknown";
  outputComplete: boolean;
};
export function watchArgv(
  packageName: string, serial: string, durationSec: number, nativeTimeout: boolean,
): string[] {
  const args = ["app", "watch-crash", packageName, "-d", serial];
  if (nativeTimeout) args.push("--monitor-timeout", String(durationSec));
  return args;
}
```

- [ ] Add fake-child timing tests for requested 60 seconds with exit after 1 second, native timeout at 60 seconds, launch waiting without a process, a stuck child, nonzero exit and output truncation. Use an injected monotonic clock so tests do not sleep for minutes.
- [ ] Add an actual wrapper argv assertion:

```js
assert.deepEqual(watchArgv("com.example.fixture", "fixture-serial", 60, true),
  ["app", "watch-crash", "com.example.fixture", "-d", "fixture-serial", "--monitor-timeout", "60"]);
```

- [ ] Inspect native timeout semantics in the retained source: it includes waiting for the process and crash signals. Report `monitoredSec: null` if the CLI does not expose enough information; elapsed time is not necessarily monitoring time. The audit found an internal 30-second bound even in 0.4.4, so do not retain the claim that it streams indefinitely.
- [ ] Implement capability-selected native timeout plus an outer watchdog with documented grace. Preserve optional start/activity behavior; no implicit launch. Keep early exit as partial/unknown coverage even when the process exit code is zero.
- [ ] Retain bounded raw stdout/stderr, hashes and truncation state with the observation. Test a crash marker outside the returned UI tail; either assess the complete retained log or report incomplete assessment. Never translate quiet partial output to no-crash success.
- [ ] Build; run `npm run test:picocli` and `node --test test/cliobservations.mjs`. Add the new suite to the derived suite inventory through the release track. Commit this timing fix separately.

## C4: Align the perf command and report contract

**Files:** modify `src/perfcli.ts`, `src/perftrace.ts`, `src/picocli.ts`, `src/clicapabilities.ts`; extend `test/picocli.mjs` and benchmark fixtures in `test/spatialbench.mjs`.

**Interface:** preserve `runPerfDiagnose` and `scorePicoCliPerfAxis` unless a documented compatibility change is necessary. Add explicit report identity/completeness rather than assuming any parsed JSON object is a useful measurement.

- [ ] Read both CLI package/consumer audits and exact vendored 0.2.0 options. The source-derived candidate is `perf live run --package PKG --duration SEC --device SERIAL --save --output PATH`; current `perf monitor run --app … -o …` is rejected. Reconcile absolute `PICO_HOME` or explicit profiler-entry configuration with the actual utility layout, separately from SDK tools-root selection. Do not silently set a guessed root, derive flags from names, or reuse a 0.3 report shape.
- [ ] Add a fake CLI that rejects `monitor`, captures argv, and writes representative 0.2.0 report fixtures only when the supported save/output arguments are passed. Mark fixtures synthetic and cite the published schema used to construct them.

```js
assert.deepEqual(capturedRun.args, ["perf", "live", "run", "--package", "com.example.fixture",
  "--duration", "15", "--device", "fixture-serial", "--save", "--output", reportPath]);
```
- [ ] Cover missing file, empty JSON object, malformed JSON, mismatched package/serial when available, stale pre-existing output, unknown report version, `SKIP`, `INSUFFICIENT_DATA`, and missing counters. Include the existing observable score boundary:

```js
assert.equal(scorePicoCliPerfAxis({status: "ok", summary: {}}, 16.7).perf, null);
assert.equal(scorePicoCliPerfAxis({status: "ok", summary: {appFps: {p5: 0, avg: 0}}}, 16.7).perf, null);
```

- [ ] Implement capability-based argv and a validated adapter for each actually supported report version. Retain the entire raw report with a hash, producer version and input identity; return a bounded view. Preserve official diagnosis states and distinguish unavailable from failed measurement.
- [ ] Correct trace load/query contracts. Request the supported load `--envelope`, validate successful `data.sessionId`, and unwrap query `data.rows` after validating success/resource/action/session identity. Retain backward parsing only for a separately identified legacy contract; default new human-readable `[TraceLoad] Session: ID` output is not a JSON session result.

```js
// Representative envelope fixture; bind its shape to the published vendor schema.
const queryEnvelope = {success:true, exitCode:0, resource:"trace", action:"query",
  data:{sessionId:"fixture-session", rpcEndpoint:"http://127.0.0.1:19001", rows:[{value:1}]}};
assert.deepEqual(validatedQueryResult.rows, queryEnvelope.data.rows);
assert.notDeepEqual(validatedQueryResult.rows, queryEnvelope);
```

- [ ] Add load/query regressions for successful envelopes, `success:false` with exit/error metadata, empty or malformed output, truncated JSON, wrong session and legacy output. Keep record/decode argv that still matches the actual declarations; capture raw streams and session/report identity. Do not add new trace analysis execution merely because the CLI advertises it.
- [ ] Propagate missing/partial measurement status into SpatialBench and doors acceptance. Never equate compositor/PxrMetric output with app FPS, absent GPU data with idle GPU, or an insufficient-data result with a passing budget.
- [ ] Build; run `npm run test:picocli`, `npm run test:bench` and affected doors fixtures. If provisioned profiler help or native sampling remains unavailable, retain that limit while completing the host adapter and tests; do not run utility setup automatically. Commit this deliverable.

## C5: Single-flight doors with complete MCP result transport

**Files:** modify `src/doors.ts`; create `src/innerclient.ts`, `test/innerclient.mjs`; extend `test/doors.mjs` and tarball startup fixtures.

**Interface:** preserve the current domain-value `innerCall` compatibility path explicitly. Add a distinct raw result path for forwarding so internal consumers do not suddenly receive an MCP envelope instead of their expected JSON object.

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
export interface InnerClient {
  callRaw(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}
export function createSingleFlightClient(connect: () => Promise<InnerClient>): () => Promise<InnerClient> {
  let pending: Promise<InnerClient> | undefined;
  return () => pending ??= connect().catch(error => { pending = undefined; throw error; });
}
```

The snippet shows initialization ownership only. The implementation must also invalidate the matching generation on close/failure and preserve existing process-lifecycle protections.

- [ ] Add a delayed fake connection and call the provider concurrently 20 times. Assert one connection, one child and identical client identity. Add failed-first-initialization/retry and old-generation-close races.
- [ ] Add raw-result fixtures containing `structuredContent`, text, image/resource blocks and `isError: true`. Assert exact preservation in the forwarding lane and intentional decoding in the domain-value lane; do not convert `isError` to a success object.
- [ ] Implement the pending connection and typed forwarding. Keep clean stdio and bounded client timeouts; avoid changing all existing door result contracts to a new nesting shape.
- [ ] Measure cold/warm fixed-input latency, response bytes and child count before/after in retained host-only fixtures. Build; run `npm run test:doors`, `node --test test/innerclient.mjs` and affected tarball tests. Commit the reviewed transport change.

## C6: Correct external APK observations and inspect real media

**Files:** modify `src/verifyapk.ts`, `src/capture.ts`, `src/picoclitools.ts`, `src/doors.ts`; create `src/artifactinspection.ts`, `test/artifactinspection.mjs`, `test/verifyapk-observation.mjs`; reuse identity/capture utilities from `src/nativefleetreceipt.ts` and immutable evidence behavior in `src/ledger.ts`.

**Interface:** external-APK observation is distinct from a fleet-native-debug build receipt. Required observation identity includes APK hash, serial, installed package/hash, boot identity, PID/start identity, foreground, capture route, capture time and immutable media hash. Record missing identity explicitly; do not synthesize it from caller claims.

- [ ] Add injected-device tests where the installed APK differs, a foreign app is foreground, the boot or process start changes, capture bytes are substituted, or an image is malformed but larger than 1000 bytes. All must fail closed or remain explicitly inconclusive as appropriate.
- [ ] Replace the `test/doors.mjs` fixture that expects killing a foreign incumbent. Ordinary verification must neither stop an unrelated app nor clear global logcat. Capture bounded package/time-scoped logs and return the actual conflict evidence.
- [ ] Select ADB/serial through explicit toolchain/target context. Remove the hardcoded old SDK path and package-only mutable `/tmp` capture output. Use unique run directories and refuse replacement of existing artifacts.
- [ ] Add media fixtures: valid small PNG, truncated PNG, arbitrary nonempty bytes, missing MP4 stream, valid dark frame and valid short recording. Check format/decoding, dimensions, hash and measured duration where a decoder is available. If no decoder is available, return unvalidated media, not a successful decode.
- [ ] Keep the recording default short and preserve the existing 180-second MCP cap unless actual route tests justify extending it. CLI 0.5's 1800-second advertisement and returned requested-duration value do not prove actual media duration. Do not build an automatic 30-minute recording into tests.
- [ ] Reuse the ledger's looked-byte checks without broadening evidence tiers. A valid dark ADB frame can be an inconclusive capture route; it is not universally proof of failed immersive rendering. Update descriptions to say what each route observes.
- [ ] Build; run the new artifact/observation suites, `npm run test:doors`, `npm run test:runreceipt`, `npm run test:ledger` and affected CLI fixtures. Native LOOK acceptance, if blocked by current constraints, must remain separately open in the checkpoint. Commit the source/fixture improvement without claiming native success.

## C7: Route new CLI capabilities and finish the implementation checkpoint

**Files:** update `src/doors.ts` descriptions only where behavior changed; update relevant public guidance through the metadata/policy process; create `docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md` and `docs/findings/CLI050_CAPABILITY_MATRIX.md` during execution.

- [ ] Map official knowledge, project context, SpatialML, plugin and Editor workflow capabilities to existing MCP user intents. Include explicit availability and whether the MCP delegates, composes, or has no execution integration. Do not add one tool per CLI command.
- [ ] Review the official 0.5 Editor bootstrap workflow controller before expanding MCP Editor orchestration. Prefer consuming its manifest/review artifacts for app integration, preserving the distinction between an Editor's decision and independently earned app/native evidence.
- [ ] Audit dated retained lessons and usage text. This audit's `pico_fix` matched a historical interactive-hang rule recommending old commands; it was not applied. Preserve historical evidence and version-scope guidance rather than treating an old keyword match as a current command contract. Do not delete the user's local lesson store.
- [ ] Finish the release and SDK subplans, reconcile shared-file edits, rebuild current source and run the necessary targeted plus release checks. Record source/build/package identity and platform-specific skips. Re-run broader tests only for changed inputs, failures or unresolved integration concerns.
- [ ] Decide release version from the actual compatibility effect; synchronize lock/manifests through supported metadata tooling and package into a fresh immutable output directory. No push or history rewrite. No release claim before required checks succeed.
- [ ] Write the two implementation documents with actual commands, results, artifact paths, before/after behavior and unresolved utility/native acceptance. Include a concise copy-paste continuation prompt for any externally blocked work. Mission Replay stays paused.

## Completion checklist

- [ ] All P0/P1 source changes reviewed and tied to regression evidence from fresh output.
- [ ] Canonical CLI 0.5 knowledge/watch/perf behavior covered; actual utility execution limits stated.
- [ ] SDK/toolchain/provenance track complete without unintended project BOM changes.
- [ ] Concurrent doors and typed-result preservation demonstrated.
- [ ] External APK/media checks preserve identity, artifacts and LOOK tiers; no foreign-app stop/global log clear in ordinary verification.
- [ ] CI inventory, smoke, docs, packaging and metadata reconcile; prior artifacts remain intact.
- [ ] New checkpoint states exactly which claims are fixture, host, native and visual evidence. No full-app or cross-platform overclaim.
