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

